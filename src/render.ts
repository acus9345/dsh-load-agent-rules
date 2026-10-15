/**
 * Model-facing text for discovered rules.
 */
import type { Rule } from './discover.ts'

/** Size-bounded rendering result. */
export interface Rendered {
  text: string
  /** Names of rules whose full body is included. */
  included: string[]
  /** Names of always-rules that did not fit and were listed instead. */
  overflow: string[]
}

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8')

const block = (rule: Rule): string => `<rule name="${rule.name}">\n${rule.body}\n</rule>`

/**
 * Render the baseline: always-on rules in full, then a catalog of the rest.
 * @param rules - discovered rules.
 * @param maxBytes - UTF-8 budget for rule bodies.
 * @param toolName - name of the on-demand reader tool.
 * @returns baseline text, or empty when there is nothing to say.
 */
export function renderBaseline(rules: readonly Rule[], maxBytes: number, toolName: string): Rendered {
  const always = rules.filter(r => r.mode === 'always')
  const included: string[] = []
  const overflow: string[] = []
  const parts: string[] = []
  let used = 0
  for (const rule of always) {
    const b = block(rule)
    if (used + byteLength(b) > maxBytes) {
      overflow.push(rule.name)
      continue
    }
    used += byteLength(b)
    parts.push(b)
    included.push(rule.name)
  }
  const glob = rules.filter(r => r.mode === 'glob')
  const requested = rules.filter(r => r.mode === 'requested' || r.mode === 'manual')
  const lines: string[] = []
  if (parts.length > 0) {
    lines.push('These are the project rules written for this repository. Follow them like the rest of your instructions.', '', ...parts)
  }
  const catalog: string[] = []
  for (const r of glob) catalog.push(`- ${r.name} (applies to ${r.globs.join(', ')})${r.description !== '' ? `: ${r.description}` : ''}`)
  for (const r of requested) catalog.push(`- ${r.name}${r.description !== '' ? `: ${r.description}` : ' (no description)'}`)
  for (const name of overflow) catalog.push(`- ${name} (always applies; too long to include here)`)
  if (catalog.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(
      'More project rules are available. File-scoped rules are added automatically the first time you read or edit a matching file.',
      `Read any of them with the \`${toolName}\` tool when it is relevant to your task:`,
      ...catalog,
    )
  }
  return { text: lines.join('\n'), included, overflow }
}

/**
 * Render rules attached because a matching file was touched.
 * @param rules - rules to attach.
 * @param path - the touched file.
 * @param maxBytes - UTF-8 budget.
 * @param toolName - reader tool, mentioned for rules that did not fit.
 * @returns text and the rules included.
 */
export function renderAttached(rules: readonly Rule[], path: string, maxBytes: number, toolName: string): Rendered {
  const parts: string[] = []
  const included: string[] = []
  const overflow: string[] = []
  let used = 0
  for (const rule of rules) {
    const b = block(rule)
    if (used + byteLength(b) > maxBytes) {
      overflow.push(rule.name)
      continue
    }
    used += byteLength(b)
    parts.push(b)
    included.push(rule.name)
  }
  const lines = [`Project rules that apply to ${path}:`, '', ...parts]
  if (overflow.length > 0) lines.push('', `Also applies (read with \`${toolName}\`): ${overflow.join(', ')}`)
  return { text: lines.join('\n'), included: [...included, ...overflow], overflow }
}
