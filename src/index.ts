/**
 * dsh-load-agent-rules: use the rule files other coding agents read.
 *
 * Discovers Cursor (`.cursor/rules/*.mdc`, `.cursorrules`), GitHub Copilot
 * (`.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`),
 * Windsurf, Cline, Kiro, Roo, Junie, and `GEMINI.md` rules in the session
 * workspace and honours each rule's activation:
 *
 * - always-on rules enter context as one durable instructions message before
 *   the first model request (and again if they change or are compacted away);
 * - glob-scoped rules are attached after the first `read`/`write`/`edit` of a
 *   matching file, through `tools/post-execute` additional context;
 * - description-only rules are listed, and the model reads them with the
 *   `project_rule` tool.
 *
 * Rule text is read from the local filesystem of the harness host.
 *
 * @module dsh-load-agent-rules
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, type PostToolDecision, type ToolExecution, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { discoverRules, RULE_SOURCES, type Rule, type RuleSource } from './discover.ts'
import { renderAttached, renderBaseline } from './render.ts'
import { matchesAny } from './shared/glob.ts'
import { resolveConfig } from './shared/live.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'load-agent-rules': {
      kind: 'load-agent-rules'
      /** Rule names whose text this message carries. */
      rules: string[]
      /** Digest of the always-on rule set, on baseline messages. */
      baseline?: string
    } & ContextFormed
  }
}

export { discoverRules, RULE_SOURCES } from './discover.ts'
export type { Rule, RuleMode, RuleSource } from './discover.ts'
export { parseFrontmatter, globList } from './frontmatter.ts'
export { renderBaseline, renderAttached } from './render.ts'

export const name = 'load-agent-rules'
export const inject = ['tools']

/** Plugin configuration. */
export interface Config {
  /** Rule formats to load. */
  sources: RuleSource[]
  /** UTF-8 budget for always-on rule bodies in the baseline message. */
  maxBaselineBytes: number
  /** UTF-8 budget for rules attached on one file touch. */
  maxAttachBytes: number
  /** Largest single rule file read. */
  maxFileBytes: number
  /** Name of the on-demand rule reader tool; empty disables it. */
  toolName: string
  /** Tools whose `file_path`/`path` argument triggers glob-scoped rules. */
  touchTools: string[]
  /** How long a discovery result is reused, in milliseconds. */
  cacheMs: number
}

// Fields marked `.volatile()` can be changed live from the settings page on
// DSH's Plugins page. `toolName` registers a tool once at startup, so it stays
// an ordinary field that needs a restart.
export const Config: Schema<Config> = Schema.object({
  sources: Schema.array(Schema.union([...RULE_SOURCES])).default([...RULE_SOURCES]).volatile(),
  maxBaselineBytes: Schema.natural().default(48_000).volatile(),
  maxAttachBytes: Schema.natural().default(24_000).volatile(),
  maxFileBytes: Schema.natural().default(200_000).volatile(),
  toolName: Schema.string().default('project_rule'),
  touchTools: Schema.array(Schema.string()).default(['read', 'write', 'edit', 'str_replace_editor']).volatile(),
  cacheMs: Schema.natural().default(5_000).volatile(),
}) as unknown as Schema<Config>

type RulesSource = Extract<UserMessage['source'], { kind: 'load-agent-rules' }>

const isRulesSource = (source: UserMessage['source']): source is RulesSource => source.kind === 'load-agent-rules'

/** Rule names and the latest baseline digest visible in the agent's current model history. */
function visibleState(agent: Agent): { rules: Set<string>; baseline: string | undefined } {
  const rules = new Set<string>()
  let baseline: string | undefined
  for (const seq of agent.session.surface.nodes) {
    // oxlint-disable-next-line typescript/no-deprecated -- eventAt is the published surface reader in 0.2.
    const event = agent.session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    const source = (event.data as UserMessage).source
    if (!isRulesSource(source)) continue
    for (const r of source.rules) rules.add(r)
    if (source.baseline !== undefined) baseline = source.baseline
  }
  return { rules, baseline }
}

const baselineDigest = (rules: readonly Rule[]): string =>
  rules.map(r => `${r.name}:${r.mode}:${r.digest}:${r.globs.join(',')}`).join('|')

export function apply(ctx: Context, config: Config): void {
  const cache = new Map<string, { at: number; rules: Rule[] }>()
  const rulesFor = (root: string): Rule[] => {
    const cfg = resolveConfig(config)
    // Sources and size limit are part of the key, so a change on the settings page applies at once.
    const key = `${root}\0${cfg.sources.join(',')}\0${cfg.maxFileBytes}`
    const hit = cache.get(key)
    if (hit !== undefined && Date.now() - hit.at < cfg.cacheMs) return hit.rules
    const rules = discoverRules(root, { sources: cfg.sources, maxFileBytes: cfg.maxFileBytes })
    cache.set(key, { at: Date.now(), rules })
    if (cache.size > 50) cache.delete(cache.keys().next().value!)
    return rules
  }
  const rootOf = (agent: Agent | undefined): string => agent?.session.header.cwd ?? process.cwd()
  /** Rules attached during the current step, not yet visible in the surface. */
  const attachedThisStep = new WeakMap<Agent, Set<string>>()

  ctx.on('agent/pre-step', async ({ agent, messages }, next): Promise<PreStepDecision> => {
    const decision = await next()
    attachedThisStep.delete(agent)
    if (decision.kind !== 'enter' || decision.messages.length === 0) return decision
    let rules: Rule[]
    try {
      rules = rulesFor(rootOf(agent))
    } catch (error) {
      ctx.logger.warn('dsh-load-agent-rules: rule discovery failed: %o', error)
      return decision
    }
    if (rules.length === 0) return decision
    const digest = baselineDigest(rules)
    const state = visibleState(agent)
    if (state.baseline === digest) return decision
    const rendered = renderBaseline(rules, resolveConfig(config).maxBaselineBytes, config.toolName)
    if (rendered.text.length === 0) return decision
    const message = createUserMessage({
      content: [{ type: 'text', text: state.baseline === undefined ? rendered.text : `Project rules were updated.\n\n${rendered.text}` }],
      source: { kind: 'load-agent-rules', form: 'instructions', rules: rendered.included, baseline: digest },
    })
    const lastClaimed = decision.messages.findLastIndex(m => messages.includes(m))
    return { ...decision, messages: decision.messages.toSpliced(lastClaimed + 1, 0, message) }
  })

  ctx.on('tools/post-execute', async (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => {
    const decision = await next()
    const cfg = resolveConfig(config)
    if (result.isError || decision.kind !== 'accept' || !cfg.touchTools.includes(exec.name) || exec.agent === undefined) return decision
    const args = exec.arguments as { file_path?: unknown; path?: unknown } | null
    const raw = typeof args?.file_path === 'string' ? args.file_path : typeof args?.path === 'string' ? args.path : undefined
    if (raw === undefined) return decision
    const root = rootOf(exec.agent)
    const rel = relative(root, isAbsolute(raw) ? raw : resolve(root, raw)).split(sep).join('/')
    if (rel.startsWith('../')) return decision
    let rules: Rule[]
    try {
      rules = rulesFor(root)
    } catch (error) {
      ctx.logger.warn('dsh-load-agent-rules: rule discovery failed: %o', error)
      return decision
    }
    const visible = visibleState(exec.agent).rules
    const pending = attachedThisStep.get(exec.agent) ?? new Set<string>()
    const due = rules.filter(r => r.mode === 'glob' && !visible.has(r.name) && !pending.has(r.name) && matchesAny(rel, r.globs))
    if (due.length === 0) return decision
    const rendered = renderAttached(due, rel, cfg.maxAttachBytes, config.toolName)
    for (const n of rendered.included) pending.add(n)
    attachedThisStep.set(exec.agent, pending)
    const message = createUserMessage({
      content: [{ type: 'text', text: rendered.text }],
      source: { kind: 'load-agent-rules', form: 'instructions', rules: rendered.included },
    })
    return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), message] }
  })

  if (config.toolName !== '') {
    ctx.tools.register(defineTool({
      name: config.toolName,
      description: 'Read one of the project rules listed in your context (Cursor, Copilot, Windsurf, Cline, Kiro, Roo rule files) by its name. Use it when a listed rule looks relevant to the task.',
      parameters: {
        name: { type: 'string', required: true, description: 'The rule name exactly as listed, e.g. ".cursor/rules/testing.mdc".' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string', required: true },
            found: { type: 'boolean', required: true },
            text: { type: 'string', required: true },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        const rules = rulesFor(rootOf(exec.agent))
        const wanted = args.name.trim().replace(/^\.\//, '')
        const rule = rules.find(r => r.name === wanted) ?? rules.find(r => r.name.endsWith(`/${wanted}`) || r.name.replace(/\.(mdc|md)$/, '').endsWith(wanted))
        if (rule === undefined) {
          const names = rules.map(r => r.name)
          return { name: wanted, found: false, text: names.length === 0 ? 'This project has no rule files.' : `No rule named "${wanted}". Available rules:\n${names.map(n => `- ${n}`).join('\n')}` }
        }
        const scope = rule.mode === 'glob' ? ` (applies to ${rule.globs.join(', ')})` : ''
        return { name: rule.name, found: true, text: `<rule name="${rule.name}"${scope}>\n${rule.body}\n</rule>` }
      },
    }))
  }
}
