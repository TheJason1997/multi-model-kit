# 路由表

模型分工是默认值，不是硬规则。主控按任务类型、风险和额度改选；用户或项目指令里点名的模型优先于本表。

## 一、走哪条路

几十行以内、原因清楚的小改动一律“直接做”，不论是谁的强项。前三条路统称单点任务。从最轻的开始；任务变大就升档，并用一句话告诉用户。用户一句话可以改档。

| 路 | 用到 | 不用 | 主控的位置 |
|---|---|---|---|
| 直接答或直接做 | 主控自己 | 派活单、看板、计划文档、交接说明、圆桌；审查只在碰钱、权限、数据、对外消息或用户点名时做 | 自己答、自己改 |
| 交给主执行者 | 一份派活单（用户原话和相关结论直接写进单子）、一个工作树 | 计划文档、看板、交接说明、逐单元推送、圆桌；审查只在碰钱、权限、数据、对外消息或用户点名时做 | 只转交用户原话和材料、核实结果，不按自己的口味改写；GPT 的结论转述成好读的话 |
| 只用流程的一部分 | 选中的 CE 环节（如 `ce-plan`、`ce-doc-review`、`ce-code-review`）及其自带的轻重分档 | 看板、交接说明、逐单元推送；审查规则同上 | 编排这几个环节，验收结果 |
| 完整流程 | `ce-brainstorm`（可选）、`ce-plan`、`ce-doc-review`、`ce-work`；看板（`.handoff.md` 前半部分）；交接说明；每个单元提交并推送；完成前审查；必要时圆桌 | — | 调度、验收、提交和推送；唯一写看板的人 |

### 主执行者专长

| 领域 | 主执行者 |
|---|---|
| 文档、文案、润色、翻译、点子 | Gemini（可以主笔） |
| 审代码、难 Bug、后端、算法、数据处理、性能、运维排查、浏览器多步操作、跨多来源的大调研 | GPT |
| 界面、视觉、动效、读懂代码库、架构取舍 | Claude |

## 二、子任务表

模型简称：Fable = `claude-fable-5-2`，Opus = `claude-opus-5-5`，GPT Astra = `gpt-6.2-astra`，GPT Sol = `gpt-6.2-sol`，Gemini = `gemini-4-neon`。

执行的默认档是 Opus、GPT Sol、Gemini，深度 medium。升到 Fable 或 GPT Astra 只在两种情况：主控判断这个单元难或风险高；默认档第一次没做对。升档时用一句话告诉用户。主控自己用什么模型不受这条限制。

深度规则：默认 medium；查找调研可降到 low；审查碰到钱、权限、数据、对外消息的文件升到 high；GPT Astra 写方案和文档用 high，写代码用 medium。

写的和审的不是同一家：默认模型和备选链上遇到作者那一家都跳过。作者是 GPT 时，评审和审查一律按 Opus → Gemini 取，深度照原行。

备选链在限额或报错时用。“什么时候升档”一列写着改派备选链的行，默认档正常返回但验收不过时，也改派给备选链的下一个。

| 任务类型 | 默认模型和深度 | 什么时候升档 | 备选链 | 理由 |
|---|---|---|---|---|
| 查找调研 | GPT Sol，low | 不升；第一次没查对就升到 medium | Gemini low → Opus low | 跨来源调研归 GPT；查找不需要深想 |
| 大方案的第二份 | GPT Sol，medium | 做错了难以撤回的方案，或默认档给出的第二份方案没有实质不同的意见：GPT Astra high | Gemini medium（只读）→ Opus medium | 另一家给独立方案，避免主控自说自话 |
| 评审计划 | GPT Sol，medium | 不升模型；碰钱、权限、数据、对外消息时深度升到 high | Gemini medium → Opus medium | 作者多为 Claude，审的换一家 |
| 界面 | Opus，medium | 整套视觉或动效重做、跨多个页面的交互，或第一次没做对：Fable | GPT Sol medium → Gemini medium | 界面、视觉、动效归 Claude |
| 界面文案 | Gemini，medium | 不升；第一次没写对就改派备选链 | Opus medium → GPT Sol medium | 文案归 Gemini |
| 跨模块难单元 | Opus，medium | 要做架构取舍、改三个以上模块的共用接口，或第一次没做对：Fable（风险大时 high） | GPT Sol medium → Gemini medium | 要读懂代码库 |
| 一般实现 | Opus，medium | 第一次没做对：Fable | GPT Sol medium → Gemini medium | 方案已定，不必用最重的模型 |
| 接口已定的硬后端 | GPT Sol，medium | 并发、事务、算法复杂，碰钱或数据，或第一次没做对：GPT Astra | Opus medium → Gemini medium | 后端、算法归 GPT |
| 难查的Bug | GPT Sol，medium | 复现不稳定、跨多个模块，或第一次没找到根因：GPT Astra | Opus medium → Gemini medium | 难 Bug 归 GPT |
| 完成前审查 | GPT Sol，medium（碰钱、权限、数据、对外消息时 high） | 不升模型，只升深度 | Opus 同档 → Gemini 同档；GPT 写的部分由 Claude 审：Opus → Gemini | 写的和审的不是同一家 |
| 文档 | Gemini，medium（主笔，交全文） | 不升；第一次没写对就改派备选链 | Opus medium → GPT Sol medium | 写文档归 Gemini |
| 文案润色 | Gemini，medium | 不升；第一次没写对就改派备选链 | Opus medium → GPT Sol medium | 润色归 Gemini |
| 翻译 | Gemini，medium | 不升；第一次没译对就改派备选链 | Opus medium → GPT Sol medium | 翻译归 Gemini |
| 点子 | Gemini，medium | 不升 | GPT Sol medium → Opus medium | 点子归 Gemini |
| 单点审代码 | GPT Sol，medium | 不升模型；碰钱、权限、数据、对外消息时深度升到 high | Opus medium → Gemini medium | 审代码归 GPT；作者是 GPT 时按 Opus → Gemini |
| 运维排查 | GPT Sol，medium | 线上故障、原因跨多个系统，或第一次没找到原因：GPT Astra | Opus medium → Gemini medium | 运维排查归 GPT |
| 浏览器多步操作 | GPT Sol，medium | 第一次没做成：GPT Astra | Opus medium → Gemini medium | 浏览器多步操作归 GPT |
| 数据处理 | GPT Sol，medium | 会改写或删除数据、数据量大到要设计分批，或第一次没做对：GPT Astra | Opus medium → Gemini medium | 数据处理归 GPT |
| 性能 | GPT Sol，medium | 瓶颈不明、要改架构才能解决，或第一次没见效：GPT Astra | Opus medium → Gemini medium | 性能归 GPT |
