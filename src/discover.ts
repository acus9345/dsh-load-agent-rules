/**
 * Discovery of rule files written for other coding agents.
 *
 * Each source maps its own activation vocabulary onto three modes:
 * `always` (in context from the start), `glob` (added when a matching file
 * is touched), and `requested` (listed with its description; the model
 * reads it on demand). `manual` rules are listed but never pushed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import { globList, parseFrontmatter } from './frontmatter.ts'

/** Supported rule sources. */
export type RuleSource = 'cursor' | 'copilot' | 'windsurf' | 'cline' | 'kiro' | 'roo' | 'gemini' | 'junie'

/** All sources, in priority order. */
export const RULE_SOURCES: readonly RuleSource[] = ['cursor', 'copilot', 'windsurf', 'cline', 'kiro', 'roo', 'gemini', 'junie']

/** How a rule is activated. */
export type RuleMode = 'always' | 'glob' | 'requested' | 'manual'

/** One discovered rule. */
export interface Rule {
  /** Stable name: workspace-relative path of the rule file. */
  name: string
  source: RuleSource
  mode: RuleMode
  /** Globs for `glob` mode (workspace-relative, already prefixed for nested rule dirs). */
  globs: string[]
  description: string
  body: string
  /** Short content digest, for change detection and dedup. */
  digest: string
}

const digestOf = (text: string): string => createHash('sha256').update(text.trim()).digest('hex').slice(0, 12)

const readText = (path: string, maxBytes: number): string | undefined => {
  try {
    const info = statSync(path)
    if (!info.isFile() || info.size > maxBytes) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    // Unreadable rule files are skipped like absent ones.
    return undefined
  }
}

/** Files under `dir` (recursive) with one of the given extensions. */
function listFiles(dir: string, exts: readonly string[], depth = 0): string[] {
  if (depth > 4 || !existsSync(dir)) return []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // An unreadable rules directory contributes nothing.
    return []
  }
  const out: string[] = []
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...listFiles(full, exts, depth + 1))
    else if (exts.some(x => e.name.endsWith(x))) out.push(full)
  }
  return out
}

const toPosix = (p: string): string => p.split(sep).join('/')

/** Prefix globs of a rule that lives in a nested `.cursor/rules` directory with that directory's project path. */
const scopeGlob = (glob: string, scopeDir: string): string => {
  if (scopeDir === '' || glob.startsWith('/')) return glob.replace(/^\//, '')
  return `${scopeDir}/${glob.includes('/') ? glob : `**/${glob}`}`
}

interface Collected { rules: Rule[]; add(rule: Omit<Rule, 'digest'>): void }

function collector(): Collected {
  const rules: Rule[] = []
  return {
    rules,
    add(rule) {
      if (rule.body.trim().length === 0) return
      rules.push({ ...rule, body: rule.body.trim(), digest: digestOf(rule.body) })
    },
  }
}

/** Discovery options. */
export interface DiscoverOptions {
  sources: readonly RuleSource[]
  /** Largest rule file read, in bytes. */
  maxFileBytes: number
}

/**
 * Discover rules for a project root.
 * @param root - project root (usually the session workspace).
 * @param options - enabled sources and size cap.
 * @returns rules in source order, deduplicated by content.
 */
export function discoverRules(root: string, options: DiscoverOptions): Rule[] {
  const enabled = new Set(options.sources)
  const c = collector()
  const rel = (p: string): string => toPosix(relative(root, p))
  const read = (p: string): string | undefined => readText(p, options.maxFileBytes)

  if (enabled.has('cursor')) {
    // Nested `.cursor/rules` directories scope their globs to their parent folder.
    for (const rulesDir of findCursorRuleDirs(root)) {
      const scopeDir = toPosix(relative(root, join(rulesDir, '..', '..')))
      for (const file of listFiles(rulesDir, ['.mdc', '.md'])) {
        const text = read(file)
        if (text === undefined) continue
        const { data, body } = parseFrontmatter(text)
        const globs = globList(data.globs).map(g => scopeGlob(g, scopeDir))
        const description = typeof data.description === 'string' ? data.description : ''
        const mode: RuleMode = data.alwaysApply === true ? 'always' : globs.length > 0 ? 'glob' : description !== '' ? 'requested' : 'manual'
        c.add({ name: rel(file), source: 'cursor', mode, globs, description, body })
      }
    }
    const legacy = read(join(root, '.cursorrules'))
    if (legacy !== undefined) c.add({ name: '.cursorrules', source: 'cursor', mode: 'always', globs: [], description: '', body: legacy })
  }

  if (enabled.has('copilot')) {
    const main = read(join(root, '.github', 'copilot-instructions.md'))
    if (main !== undefined) c.add({ name: '.github/copilot-instructions.md', source: 'copilot', mode: 'always', globs: [], description: '', body: main })
    for (const file of listFiles(join(root, '.github', 'instructions'), ['.instructions.md'])) {
      const text = read(file)
      if (text === undefined) continue
      const { data, body } = parseFrontmatter(text)
      const globs = globList(data.applyTo)
      const description = typeof data.description === 'string' ? data.description : ''
      const always = globs.some(g => g === '**' || g === '**/*' || g === '*')
      const mode: RuleMode = always ? 'always' : globs.length > 0 ? 'glob' : description !== '' ? 'requested' : 'manual'
      c.add({ name: rel(file), source: 'copilot', mode, globs: always ? [] : globs, description, body })
    }
  }

  if (enabled.has('windsurf')) {
    const legacy = read(join(root, '.windsurfrules'))
    if (legacy !== undefined) c.add({ name: '.windsurfrules', source: 'windsurf', mode: 'always', globs: [], description: '', body: legacy })
    for (const file of listFiles(join(root, '.windsurf', 'rules'), ['.md'])) {
      const text = read(file)
      if (text === undefined) continue
      const { data, body } = parseFrontmatter(text)
      const trigger = typeof data.trigger === 'string' ? data.trigger : 'always_on'
      const globs = globList(data.globs)
      const description = typeof data.description === 'string' ? data.description : ''
      const mode: RuleMode = trigger === 'glob' && globs.length > 0 ? 'glob' : trigger === 'model_decision' ? 'requested' : trigger === 'manual' ? 'manual' : 'always'
      c.add({ name: rel(file), source: 'windsurf', mode, globs: mode === 'glob' ? globs : [], description, body })
    }
  }

  if (enabled.has('cline')) {
    const clinePath = join(root, '.clinerules')
    const asFile = read(clinePath)
    if (asFile !== undefined) c.add({ name: '.clinerules', source: 'cline', mode: 'always', globs: [], description: '', body: asFile })
    for (const file of listFiles(clinePath, ['.md', '.txt'])) {
      const text = read(file)
      if (text === undefined) continue
      const { data, body } = parseFrontmatter(text)
      const globs = globList(data.paths)
      c.add({ name: rel(file), source: 'cline', mode: globs.length > 0 ? 'glob' : 'always', globs, description: typeof data.description === 'string' ? data.description : '', body })
    }
  }

  if (enabled.has('kiro')) {
    for (const file of listFiles(join(root, '.kiro', 'steering'), ['.md'])) {
      const text = read(file)
      if (text === undefined) continue
      const { data, body } = parseFrontmatter(text)
      const inclusion = typeof data.inclusion === 'string' ? data.inclusion : 'always'
      const globs = globList(data.fileMatchPattern)
      const description = typeof data.description === 'string' ? data.description : ''
      const mode: RuleMode = inclusion === 'fileMatch' && globs.length > 0 ? 'glob' : inclusion === 'manual' ? (description !== '' ? 'requested' : 'manual') : 'always'
      c.add({ name: rel(file), source: 'kiro', mode, globs: mode === 'glob' ? globs : [], description, body })
    }
  }

  if (enabled.has('roo')) {
    for (const file of listFiles(join(root, '.roo', 'rules'), ['.md', '.txt'])) {
      const text = read(file)
      if (text !== undefined) c.add({ name: rel(file), source: 'roo', mode: 'always', globs: [], description: '', body: parseFrontmatter(text).body })
    }
    const legacy = read(join(root, '.roorules'))
    if (legacy !== undefined) c.add({ name: '.roorules', source: 'roo', mode: 'always', globs: [], description: '', body: legacy })
  }

  if (enabled.has('gemini')) {
    const gemini = read(join(root, 'GEMINI.md'))
    if (gemini !== undefined) c.add({ name: 'GEMINI.md', source: 'gemini', mode: 'always', globs: [], description: '', body: gemini })
  }

  if (enabled.has('junie')) {
    const junie = read(join(root, '.junie', 'guidelines.md'))
    if (junie !== undefined) c.add({ name: '.junie/guidelines.md', source: 'junie', mode: 'always', globs: [], description: '', body: junie })
  }

  // Many repos symlink or copy one file under several names; DSH already loads AGENTS.md/CLAUDE.md itself.
  const native = new Set(['AGENTS.md', 'CLAUDE.md'].map(n => read(join(root, n))).filter((t): t is string => t !== undefined).map(digestOf))
  const seen = new Set<string>()
  return c.rules.filter((r) => {
    if (native.has(r.digest) || seen.has(r.digest)) return false
    seen.add(r.digest)
    return true
  })
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.venv', 'venv', '.next', 'vendor'])

/** `.cursor/rules` directories at the root and in subfolders (bounded depth). */
function findCursorRuleDirs(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    const rules = join(dir, '.cursor', 'rules')
    if (existsSync(rules)) out.push(rules)
    if (depth >= 3) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      // Unreadable folders are skipped.
      return
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(join(dir, e.name), depth + 1)
    }
  }
  walk(root, 0)
  return out
}
