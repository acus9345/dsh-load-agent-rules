import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pluginEntry, runDsh } from './helpers/dsh.ts'

const plugin = { id: 'load-agent-rules', entry: pluginEntry }
const files = {
  '.cursor/rules/style.mdc': '---\nalwaysApply: true\n---\nALWAYS-RULE: use tabs for indentation.',
  '.cursor/rules/react.mdc': '---\nglobs: "*.tsx"\ndescription: React conventions\n---\nGLOB-RULE: use function components.',
  '.github/instructions/db.instructions.md': '---\ndescription: Database migration conventions\n---\nREQUESTED-RULE: never edit old migrations.',
  'src/App.tsx': 'export const App = () => null\n',
  'src/util.ts': 'export const x = 1\n',
}

test('always rules up front, glob rules on touch, requested rules via the tool', async () => {
  const run = await runDsh({
    plugins: [plugin],
    files,
    script: [
      { tool: 'read', input: { file_path: 'src/util.ts' } },
      { tool: 'read', input: { file_path: 'src/App.tsx' } },
      { tool: 'read', input: { file_path: 'src/App.tsx' } },
      { tool: 'project_rule', input: { name: '.github/instructions/db.instructions.md' } },
    ],
  })
  assert.equal(run.exitCode, 0, run.stderr)
  const main = run.requests.filter(r => Array.isArray(r.tools) && r.tools.length > 0)
  const req = (i: number): string => JSON.stringify(main[i]!.messages)
  // The tool is offered to the model.
  assert.ok(main[0]!.tools!.some(t => t.name === 'project_rule'))
  // Baseline: always rule in full, others listed, before the first request.
  assert.match(req(0), /ALWAYS-RULE/)
  assert.match(req(0), /react\.mdc \(applies to \*\.tsx\): React conventions/)
  assert.doesNotMatch(req(0), /GLOB-RULE/)
  // Reading a .ts file does not attach the .tsx rule; reading App.tsx does, once.
  assert.doesNotMatch(req(1), /GLOB-RULE/)
  assert.match(req(2), /GLOB-RULE/)
  assert.equal(req(3).split('GLOB-RULE').length - 1, 1)
  // The baseline is not repeated on later steps.
  assert.equal(req(4).split('ALWAYS-RULE').length - 1, 1)
  // Requested rule comes back from the tool.
  assert.match(run.toolResults[3]!.result, /REQUESTED-RULE/)
})

test('a project without rule files is left alone', async () => {
  const run = await runDsh({ plugins: [plugin], files: { 'a.txt': 'x' }, script: [{ tool: 'project_rule', input: { name: 'x' } }] })
  assert.equal(run.exitCode, 0, run.stderr)
  assert.match(run.toolResults[0]!.result, /no rule files/)
})

test('works when installed with `dsh plugin add`', async () => {
  const run = await runDsh({
    installed: true,
    files,
    script: [{ tool: 'project_rule', input: { name: '.github/instructions/db.instructions.md' } }],
  })
  assert.equal(run.exitCode, 0, run.stderr)
  const first = run.requests.find(r => Array.isArray(r.tools) && r.tools.length > 0)!
  assert.match(JSON.stringify(first.messages), /ALWAYS-RULE/)
  assert.match(run.toolResults[0]!.result, /REQUESTED-RULE/)
})
