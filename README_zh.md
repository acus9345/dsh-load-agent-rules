# dsh-load-agent-rules

[English](README.md) | 中文

很多仓库里其实已经写好了给 AI 智能体的规则，只是格式不是 DeepSeek Harness 读的那种。团队里有人写了 `.cursor/rules/testing.mdc`，有人加了 `.github/copilot-instructions.md`，还有大家试用 Windsurf 那个月留下的 `.windsurfrules`。DSH 会读 `AGENTS.md` 和 `CLAUDE.md`，其余的都不管。所以智能体从来没听说过"我们用 Vitest 不用 Jest"或"不要改旧的迁移文件"，尽管这些就写在仓库里。

这个插件会找到这些规则文件，按各个工具原本的用法交给模型。你不需要转换或复制任何东西。

## 安装

```sh
dsh plugin --profile web add dsh-load-agent-rules
```

这里用的是 `web` 配置（profile），也就是用 `dsh web` 打开的浏览器界面。如果你用别的方式运行 DSH，就换成 `headless`（脚本和 CI）或 `acp`（编辑器集成）。每个配置有自己的插件列表，你用到哪个就装到哪个。从下一个会话开始生效。卸载用 `dsh plugin --profile web remove dsh-load-agent-rules`。

### 从源码安装

想试本地改动的话，打个包再装：

```sh
git clone https://github.com/acus9345/dsh-load-agent-rules
cd dsh-load-agent-rules
npm install
npm pack
dsh plugin --profile web add ./dsh-load-agent-rules-0.2.0.tgz
```

## 会读哪些文件

| 工具 | 文件 |
| --- | --- |
| Cursor | `.cursor/rules/**/*.mdc`（子目录里嵌套的也算）、`.cursorrules` |
| GitHub Copilot | `.github/copilot-instructions.md`、`.github/instructions/*.instructions.md` |
| Windsurf | `.windsurf/rules/*.md`、`.windsurfrules` |
| Cline | `.clinerules`（文件或目录） |
| Kiro | `.kiro/steering/*.md` |
| Roo Code | `.roo/rules/*`、`.roorules` |
| Gemini CLI | `GEMINI.md` |
| JetBrains Junie | `.junie/guidelines.md` |

很多仓库会在好几个名字下放同样的内容，常常是符号链接。重复的会被去掉；和你的 `AGENTS.md` 或 `CLAUDE.md` 完全相同的也会被去掉，因为 DSH 已经加载了它们。

## 规则怎么交给模型

这些工具对"规则什么时候生效"各有各的定义。插件保留这些含义，而不是把所有规则一股脑塞进提示词。

**始终生效的规则**在会话开始时放进上下文一次。包括 Cursor 的 `alwaysApply: true`、Copilot 的主说明文件、Windsurf 的 `always_on`、Kiro 的 `inclusion: always`，以及 `.cursorrules` 这样的普通文件。如果规则文件在会话中途改了，或者上下文压缩把规则丢了，会重新发送。

**按文件生效的规则**等到用得上时才出现。带 `globs: "*.tsx"` 的 Cursor 规则、带 `applyTo: "src/db/**"` 的 Copilot 文件、Kiro 的 `fileMatch` 或 Windsurf 的 `glob` 规则，会在智能体第一次读取或编辑匹配的文件时附上。只附一次，不会每次碰到都附。嵌套在 `packages/web/.cursor/rules/` 里的规则只在 `packages/web/` 内生效。

**只有描述的规则**（Cursor 的"agent requested"、Windsurf 的 `model_decision`）会列出名字和描述。模型觉得哪条相关时，可以用一个小工具 `project_rule` 打开它。只能手动启用的规则也会出现在这个列表里。

所以模型收到的第一个请求里会带上类似这样的内容（这部分是给模型看的，所以是英文）：

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

## 设置

最简单的办法：在 DSH 侧边栏打开 **插件**，点 **dsh-load-agent-rules**，改好后点 **保存**。下一次工具调用就生效，不用重启（只有 `toolName` 改了仍需重启，所以它不在设置页面上）。

或者在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里加一行这样的配置（只影响一个配置），或者加到 `~/.dsh/cordis.patch.yml`（影响所有配置）。没写的项保持默认值。

```yaml
- id: load-agent-rules
  config:
    sources: [cursor, copilot, windsurf, cline, kiro, roo, gemini, junie]   # 不想要的删掉
    maxBaselineBytes: 48000    # 始终生效规则的容量，超出的只列出名字
    maxAttachBytes: 24000      # 碰到一个文件时附带规则的容量
    maxFileBytes: 200000       # 跳过比这更大的规则文件
    toolName: project_rule     # 设为 '' 则不注册这个工具
    touchTools: [read, write, edit, str_replace_editor]
```

如果始终生效的规则超出了容量，放不下的那些会附注说明列出来，模型需要时用工具读取。不会悄悄截掉任何内容。

## 开发

```sh
npm install
npm test           # 规则发现和渲染的单元测试
npm run test:e2e   # 用脚本模拟的本地模型跑真实的 dsh，不需要 API Key
```

安装测试会执行 `dsh plugin add`，需要 PATH 里有 `pnpm`。

MIT 许可。作者 [acus9345](https://github.com/acus9345)。欢迎在 issues 里报 bug 或提想法。
