# dsh-load-agent-rules

Lots of repos already have rules for AI agents, just not in a format DeepSeek Harness reads. Someone on the team wrote `.cursor/rules/testing.mdc`, another person added `.github/copilot-instructions.md`, and there's a `.windsurfrules` from that one month everyone tried Windsurf. DSH reads `AGENTS.md` and `CLAUDE.md`, but it ignores the rest. So the agent never hears "we use Vitest, not Jest" or "never edit old migrations", even though it's written down right there in the repo.

This plugin finds those rule files and gives them to the model the way each tool meant them to be used. You don't have to convert or copy anything.

## Install

```sh
dsh plugin --profile web add dsh-load-agent-rules
```

That's the `web` profile, the browser UI you start with `dsh web`. If you run DSH another way, use `headless` (scripts and CI) or `acp` (editor integrations) instead. Each profile keeps its own plugin list, so add it to every profile you use. It starts working in the next session. Remove it with `dsh plugin --profile web remove dsh-load-agent-rules`.

### From a clone

Before the package is on npm, or to try local changes, build a tarball and install that:

```sh
git clone https://github.com/acus9345/dsh-load-agent-rules
cd dsh-load-agent-rules
npm install
npm pack
dsh plugin --profile web add ./dsh-load-agent-rules-0.1.0.tgz
```

## Which files it reads

| Tool | Files |
| --- | --- |
| Cursor | `.cursor/rules/**/*.mdc` (nested ones in subfolders too), `.cursorrules` |
| GitHub Copilot | `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` |
| Windsurf | `.windsurf/rules/*.md`, `.windsurfrules` |
| Cline | `.clinerules` (file or folder) |
| Kiro | `.kiro/steering/*.md` |
| Roo Code | `.roo/rules/*`, `.roorules` |
| Gemini CLI | `GEMINI.md` |
| JetBrains Junie | `.junie/guidelines.md` |

Many repos have the same text under several names, often as a symlink. Duplicates are dropped, and so is anything identical to your `AGENTS.md` or `CLAUDE.md`, since DSH already loads those.

## How rules reach the model

Each of those tools has its own idea of when a rule applies. The plugin keeps those meanings instead of dumping every rule into the prompt.

**Always-on rules** go into context once, at the start of the session. That covers Cursor's `alwaysApply: true`, Copilot's main instructions file, Windsurf `always_on`, Kiro `inclusion: always`, and plain files like `.cursorrules`. If a rule file changes mid-session, or context compaction drops the rules, they're sent again.

**File-scoped rules** wait until they're relevant. A Cursor rule with `globs: "*.tsx"`, a Copilot file with `applyTo: "src/db/**"`, a Kiro `fileMatch` or a Windsurf `glob` rule gets attached the first time the agent reads or edits a matching file. It's attached once, not on every touch. Rules in a nested `packages/web/.cursor/rules/` folder only apply inside `packages/web/`.

**Rules with only a description** (Cursor's "agent requested", Windsurf `model_decision`) are listed by name and description. The model can open any of them with a small `project_rule` tool when it decides one is relevant. Manual-only rules show up in that list too.

So the model's first request carries something like this:

```
These are the project rules written for this repository. Follow them like the rest of your instructions.

<rule name=".cursor/rules/style.mdc">
Use tabs for indentation. Prefer named exports.
</rule>

More project rules are available. File-scoped rules are added automatically the first time you read or edit a matching file.
Read any of them with the `project_rule` tool when it is relevant to your task:
- .cursor/rules/react.mdc (applies to *.tsx): React conventions
- .github/instructions/db.instructions.md: Database migration conventions
```

## Settings

The easy way: open **Plugins** in DSH's sidebar, click **dsh-load-agent-rules**, change what you want and press **Save**. It applies to the next tool call, no restart needed (`toolName` is the one setting that still needs a restart, so it is not on the page).

Or add a row like this to `~/.dsh/profiles/<profile>/cordis.patch.yml`, or to `~/.dsh/cordis.patch.yml` for every profile. Keys you leave out keep their defaults.

```yaml
- id: load-agent-rules
  config:
    sources: [cursor, copilot, windsurf, cline, kiro, roo, gemini, junie]   # drop any you don't want
    maxBaselineBytes: 48000    # budget for always-on rules; the rest are listed instead
    maxAttachBytes: 24000      # budget for rules attached on one file touch
    maxFileBytes: 200000       # skip rule files bigger than this
    toolName: project_rule     # '' to not register the tool
    touchTools: [read, write, edit, str_replace_editor]
```

If your always-on rules go over the budget, the ones that don't fit are listed with a note, and the model reads them with the tool. Nothing is silently cut.

## Development

```sh
npm install
npm test           # discovery and rendering unit tests
npm run test:e2e   # real dsh runs against a scripted local model, no API key needed
```

The install test runs `dsh plugin add`, which needs `pnpm` on your PATH.

MIT licensed. Written by [acus9345](https://github.com/acus9345). Bug reports and ideas are welcome in the issues.
