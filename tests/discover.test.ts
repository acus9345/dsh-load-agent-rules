import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverRules, RULE_SOURCES } from '../src/discover.ts'
import { parseFrontmatter, globList } from '../src/frontmatter.ts'
import { renderBaseline } from '../src/render.ts'

const project = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'rules-'))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  return dir
}
const opts = { sources: RULE_SOURCES, maxFileBytes: 100_000 }

test('front matter: scalars, inline and block lists, comma globs', () => {
  const { data, body } = parseFrontmatter('---\ndescription: "Testing rules"\nglobs: src/**/*.ts, tests/**\nalwaysApply: false\ntags:\n  - a\n  - b\n---\nBody here\n')
  assert.equal(data.description, 'Testing rules')
  assert.deepEqual(globList(data.globs), ['src/**/*.ts', 'tests/**'])
  assert.equal(data.alwaysApply, false)
  assert.deepEqual(data.tags, ['a', 'b'])
  assert.equal(body, 'Body here\n')
  assert.deepEqual(parseFrontmatter('no front matter').data, {})
  assert.deepEqual(globList(parseFrontmatter('---\nglobs: ["*.py", "*.pyi"]\n---\n').data.globs), ['*.py', '*.pyi'])
})

test('cursor rules map to always / glob / requested / manual', () => {
  const root = project({
    '.cursor/rules/style.mdc': '---\nalwaysApply: true\n---\nUse tabs.',
    '.cursor/rules/react.mdc': '---\nglobs: "*.tsx"\n---\nUse function components.',
    '.cursor/rules/db.mdc': '---\ndescription: Database migration conventions\n---\nNever edit old migrations.',
    '.cursor/rules/misc.mdc': 'Manual rule.',
    '.cursorrules': 'Legacy rule.',
  })
  const rules = discoverRules(root, opts)
  const byName = Object.fromEntries(rules.map(r => [r.name, r]))
  assert.equal(byName['.cursor/rules/style.mdc']!.mode, 'always')
  assert.equal(byName['.cursor/rules/react.mdc']!.mode, 'glob')
  assert.deepEqual(byName['.cursor/rules/react.mdc']!.globs, ['*.tsx'])
  assert.equal(byName['.cursor/rules/db.mdc']!.mode, 'requested')
  assert.equal(byName['.cursor/rules/misc.mdc']!.mode, 'manual')
  assert.equal(byName['.cursorrules']!.mode, 'always')
})

test('nested .cursor/rules scope globs to their folder', () => {
  const root = project({ 'apps/web/.cursor/rules/ui.mdc': '---\nglobs: "*.tsx"\n---\nWeb UI rule.' })
  const [rule] = discoverRules(root, opts)
  assert.deepEqual(rule!.globs, ['apps/web/**/*.tsx'])
})

test('copilot, windsurf, cline, kiro, roo, gemini', () => {
  const root = project({
    '.github/copilot-instructions.md': 'Copilot main.',
    '.github/instructions/py.instructions.md': '---\napplyTo: "**/*.py"\n---\nType hints everywhere.',
    '.github/instructions/all.instructions.md': '---\napplyTo: "**"\n---\nAlways.',
    '.windsurf/rules/api.md': '---\ntrigger: glob\nglobs: api/**\n---\nREST rules.',
    '.windsurf/rules/think.md': '---\ntrigger: model_decision\ndescription: When designing APIs\n---\nThink first.',
    '.clinerules/01-general.md': 'Cline general.',
    '.kiro/steering/tests.md': '---\ninclusion: fileMatch\nfileMatchPattern: "**/*.test.ts"\n---\nUse vitest.',
    '.roo/rules/roo.md': 'Roo rule.',
    'GEMINI.md': 'Gemini rule.',
  })
  const modes = Object.fromEntries(discoverRules(root, opts).map(r => [r.name, r.mode]))
  assert.deepEqual(modes, {
    '.github/copilot-instructions.md': 'always',
    '.github/instructions/all.instructions.md': 'always',
    '.github/instructions/py.instructions.md': 'glob',
    '.windsurf/rules/api.md': 'glob',
    '.windsurf/rules/think.md': 'requested',
    '.clinerules/01-general.md': 'always',
    '.kiro/steering/tests.md': 'glob',
    '.roo/rules/roo.md': 'always',
    'GEMINI.md': 'always',
  })
})

test('duplicates of AGENTS.md and of each other are dropped', () => {
  const root = project({ 'AGENTS.md': 'Same text.', 'GEMINI.md': 'Same text.', '.cursorrules': 'Other.', '.windsurfrules': 'Other.' })
  assert.deepEqual(discoverRules(root, opts).map(r => r.name), ['.cursorrules'])
})

test('sources can be disabled', () => {
  const root = project({ '.cursorrules': 'x', 'GEMINI.md': 'y' })
  assert.deepEqual(discoverRules(root, { ...opts, sources: ['gemini'] }).map(r => r.name), ['GEMINI.md'])
})

test('baseline rendering respects the byte budget and lists the rest', () => {
  const root = project({
    '.cursor/rules/a.mdc': '---\nalwaysApply: true\n---\n' + 'a'.repeat(100),
    '.cursor/rules/b.mdc': '---\nalwaysApply: true\n---\n' + 'b'.repeat(5000),
    '.cursor/rules/c.mdc': '---\nglobs: "*.go"\ndescription: Go style\n---\nGo rule.',
  })
  const out = renderBaseline(discoverRules(root, opts), 1000, 'project_rule')
  assert.deepEqual(out.included, ['.cursor/rules/a.mdc'])
  assert.deepEqual(out.overflow, ['.cursor/rules/b.mdc'])
  assert.match(out.text, /\.cursor\/rules\/c\.mdc \(applies to \*\.go\): Go style/)
  assert.match(out.text, /project_rule/)
})
