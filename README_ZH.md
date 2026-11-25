# multi-model-kit

让 Claude 当主控，带着 Claude、GPT、Gemini 一起干活：按专长分派，换一家模型来审，跨会话和跨机器接着做，撞到限额也不停。

[English](README.md) | 简体中文

<p align="center">
  <a href="https://thejason1997.github.io/multi-model-kit/architecture/story.zh.html">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/architecture/story.zh-dark.svg">
      <img src="docs/architecture/story.zh-light.svg" alt="动画演示：主控把活分给三家模型，换一家来审，撞限额时启动器换 org，进度保存在 git 里" width="100%">
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://thejason1997.github.io/multi-model-kit/architecture/story.zh.html"><b>打开可交互的版本</b></a>
  （可以拖动进度、点任意节点、搜索、切换深浅色）
</p>

它只是一组文件，挂在 [Claude Code](https://claude.com/claude-code)、T3 Code 和 compound-engineering 插件之上：一段全局规则、三个 skill、一个启动器、一个 Claude Code mod。没有服务端，除了你已经在用的工具，不需要装别的。

## 解决什么问题

| 问题 | 这套工具怎么做 |
|---|---|
| 一个模型包办所有事，包括它不擅长的 | 主控按专长分派。界面、架构、读懂代码库归 Claude；后端、难 Bug、调研归 GPT；文档、文案、点子归 Gemini。 |
| 模型自己审自己 | 审的和写的不是同一家。只有说得出怎么出事才挡，最多两轮，两轮不过交给你定。 |
| 撞到限额任务就停 | 窗口用到 80% 开始省着用。到 95% 启动器换第二个 org 重启 Claude，续上同一段对话。所有 org 都受限时，Codex 在前台接着做。 |
| 新会话或换机器要从头讲一遍 | 代码和 `.handoff.md` 放进同一个提交，云端会话、手机、明天的会话只凭分支就能接着做。 |

## 怎么运作

每张图都能交互：点一个节点，看它的上游和下游。

1. **[总览](https://thejason1997.github.io/multi-model-kit/architecture/overview.zh.html)。** 你只说一次。主控读共用规则，选一条够用的最轻的路：直接答、交给一个执行者、只用流程的一部分，或走完整流程。
2. **[一个单元](https://thejason1997.github.io/multi-model-kit/architecture/dispatch.zh.html)。** 一份六项的派活单交给一个执行者，它在自己的 git 工作树里做，交回时不提交。主控重跑检查、提交，再把改动交给另一家模型审。
3. **[限额处理](https://thejason1997.github.io/multi-model-kit/architecture/quota.zh.html)。** `claude-org` 让每个 org 在自己的配置目录里登录，不读任何凭据。mod 把会话 id 交给启动器，启动器换另一个 org 重启 Claude。
4. **[交接](https://thejason1997.github.io/multi-model-kit/architecture/handoff.zh.html)。** `.handoff.md` 里有看板（你的原话、已定决策、各执行者的结论）和九条交接说明。推一个信号分支就能把云端会话叫回来。

## 里面有什么

| 路径 | 是什么 |
|---|---|
| `rules/multi-model.md` | 全局规则，约 15 行。`install.sh` 把它写在一对标记之间。 |
| `skills/dispatch/` | 路由表、派活单模板、回执格式、备选链、圆桌做法。 |
| `skills/task-handoff/` | `.handoff.md` 模板，以及每单元、转云端、回本机的步骤。 |
| `skills/prompt-library/` | 12 条提示词和选用表。 |
| `bin/claude-org` | 启动器：在某个 org 下启动 Claude，mod 要求时换另一个 org 重启。 |
| `bin/quota-status` | 打印最近的额度读数，以及是否处在省额度模式。 |
| `mods/org-switch/` | Claude Code mod：盯着额度窗口，80% 降思考深度，95% 交接，提供 `/org` 命令。 |
| `docs/architecture/` | 上面这些图、它们的 JSON 源文件，以及重建用的 `build.sh`。 |

## 安装

```sh
git clone https://github.com/TheJason1997/multi-model-kit.git
cd multi-model-kit
sh install.sh --check   # 只报告现状，不改任何文件
sh install.sh           # 链接 skill 和 quota-status，写入规则
```

`install.sh` 覆盖三个工具，配置目录不存在的会跳过：

| 工具 | 规则写进 | skill 链接到 |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | `~/.claude/skills/` |
| Codex | `~/.codex/AGENTS.md` | `~/.agents/skills/` |
| Gemini CLI | `~/.gemini/GEMINI.md` | `~/.gemini/skills/` |

安装脚本会把 `~/.local/bin/quota-status` 链接到本仓库的 `bin/quota-status`。删除这个符号链接即可卸载该命令。

重复执行结果不变。标记之外的内容逐字节保留，指令文件是符号链接时写到链接指向的真实文件。任何一个目标有冲突，整次安装在写入之前就退出。冲突包括：同名但不属于本仓库的 skill、只读文件或悬空链接、不可写的目录、不成对的标记、带 CRLF 的标记行。

已知限制：存在 `~/.codex/AGENTS.override.md` 时，Codex 可能只读那个文件，安装脚本不处理这种情况。

要移除，删掉各指令文件里 `<!-- BEGIN multi-model-kit -->` 到 `<!-- END multi-model-kit -->` 这一段，再移除指向本仓库的 skill 链接。

## 两个 org，一段对话

这部分给有两个 Claude org 或席位的人用。没有的话可以跳过，规则和 skill 不依赖它。

```sh
cp orgs.example.json orgs.json          # 填你的 org 名和配置目录
sh bin/claude-org setup org2            # 建第二个配置目录
CLAUDE_CONFIG_DIR=~/.claude-org2 claude auth login
sh bin/claude-org                       # 在还有额度的 org 下启动
```

会话里用 `/org` 看各 org 的窗口，用 `/org switch` 手动切换。`orgs.json` 只留在你的电脑上，已写进 `.gitignore`。

| 什么时候 | 会发生什么 |
|---|---|
| 某个窗口到 80%（`CLAUDE_ORG_SOFT_PCT`） | 思考深度降一档，最低到 medium。`quota-status` 显示省额度模式，规则要求主控只做调度，执行改派给别人。 |
| 某个窗口到 95%，另一个 org 有额度 | Claude 退出，启动器用 `--resume` 在另一个 org 下重启，对话接着走。`--` 之后的参数原样保留。 |
| 所有 org 都受限，20 分钟内恢复 | 会话等待，到时自己继续。 |
| 所有 org 都受限，时间更长 | 启动器在同一个终端、同一个目录里运行 `codex exec`。Codex 只改文件，不提交。它退出且额度恢复后，Claude 回来，先看 `git diff` 和 `.codex-takeover-notes.md`，审过再提交。 |

Codex 接手有四个条件：当前目录是 git 仓库、有 `.handoff.md`、工作目录干净、装了 `codex`。不满足就只等待。

**没有防住的情况。** 在 `claude-org` 所在的终端里，Claude 和 Codex 不会同时运行。但你自己在同一个目录另开的会话，没有任何东西拦着它改同一批文件。

## 在 T3 Code 里

| 问题 | 结论 |
|---|---|
| 怎么用第二个 org？ | 在 T3 设置里再加一个 Claude 实例，`CLAUDE_CONFIG_DIR` 指向那个 org 的配置目录，模型选择器里马上就能选到。 |
| 会自己换 org 吗？ | 两个单元之间会，一轮对话中途不会。给每个 Claude 实例加 `CLAUDE_ORG`、`CLAUDE_ORGS` 和 `CLAUDE_CODE_PLUGIN_DIRS=<仓库>/mods/org-switch`，并在 `orgs.json` 里写上实例名（`t3Instance`）。这样 mod 在 T3 会话里只记录额度，不做任何切换。主控每个单元开始前运行 `quota-status`，看到“建议换到: <org>（T3 实例 <实例名>）”就把自己的线程切到那个实例。一轮中途撞满时仍要你手动切。 |
| 换过去后对话还在吗？ | 还没验证。 |
| 能看到额度百分比吗？ | 能，在 **Usage → Limits** 里，或输入 `/usage-limits`。模型通过 `quota-status` 读取。 |
| 所有 Claude org 都受限时，Codex 会自己接手吗？ | 不会，T3 没有这样的触发器。手动把线程切到 GPT；同一份规则已经装给 Codex，它可以当主控。 |
| 本机能给运行中的云端会话发消息吗？ | 能：`claude -p "消息" --cloud "<会话 id 或链接>"`。依据是官方文档和命令行帮助，这里没有真的发过。 |

## 现状

自动检查全部通过：

```sh
sh tests/install.test.sh                    # 106 项
sh tests/claude-org.test.sh                 # 49 项
claude plugin validate mods/org-switch
claude plugin test mods/org-switch          # 44 项
```

下面这些还没有真实跑过：

- 在两个已登录的 org 之间切换并续上同一段对话。
- 真实的 `codex exec` 接手。
- 转到云端会话再回本机的完整往返。
- Gemini CLI 加载规则和 skill。路径来自它的官方文档。

## 重建图

图用 [Archify](https://github.com/tt-a1i/archify) 生成，源文件在 `docs/architecture/src/`。

```sh
sh docs/architecture/build.sh /path/to/archify/bin/archify.mjs
```

## 许可证

[MIT](LICENSE)
