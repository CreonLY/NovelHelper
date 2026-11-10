# NovelHelper

面向长篇网络小说创作的单机 Agent 应用。
核心不是"让模型写一章"，而是**让一部长篇在 200 章之后仍然自洽**。

## 架构分层

| 层 | 职责 | 对应传统后端 |
|---|---|---|
| `src/app/api/*` | 接入层：REST + SSE | Controller |
| `src/lib/agent/loop.ts` | Run / Step 状态机，落盘可续跑 | 事务 + WAL |
| `src/lib/agent/assembler.ts` | 上下文装配（分层 + 预算裁剪） | 查询组装 + 缓存 |
| `src/lib/agent/workflow.ts` | 章纲 → 正文 的 SOP | Service 层流程 |
| `src/lib/llm/gateway.ts` | 重试 / 超时 / 计量 / 契约校验 | RPC 网关 + DAO |
| `src/lib/db.ts` | SQLite 状态模型 | 持久化层 |
| `src/skills/**/*.md` | 提示词 SOP，带版本 | 配置即代码 |

## 快速开始

要求 **Node.js ≥ 22.5**（用到内置 `node:sqlite`，无需原生编译）。

```bash
npm i -g pnpm      # 或用 corepack enable
pnpm install
pnpm dev           # http://127.0.0.1:3000
```

首次打开：

1. 在「模型网关」里填 Base URL + 模型名 + API Key，保存。
   - DeepSeek 官方：`https://api.deepseek.com/v1`，模型 `deepseek-chat`
   - 中转站：填它给的 `/v1` 地址即可，协议一致
2. 在「作品设定」填标题、题材、核心设定、风格样本（贴你自己的旧文，用于模仿句长与对话密度）。
3. 填章序与本章要求，点「生成本章」。

密钥只写在本地 `data/novel.db`，接口只回传掩码，不会发到浏览器。

## 已实现（v0.1）

- 模型网关：OpenAI 兼容端点、3 次指数退避重试、超时、调用记账、`response_format` 不支持时自动降级
- 结构化输出：zod 契约校验 + 失败回灌修复（最多 2 次），仍失败则显式报错
- 上下文装配：L0 宪章 / L1 状态 / L2 风格样本 / L3 局部上下文，超预算时只裁可选项
- Agent Loop：Run + Step 落盘，每步内容入库，支持事后回放
- 章纲 → 正文两段式生成，SSE 流式推送
- 线索表：章纲声明的埋伏笔/收伏笔由代码写入，不交给模型
- 工作台 UI：模型配置、作品设定、步骤状态、上下文构成可视化、正文流式输出

## 数据模型（`data/novel.db`）

| 表 | 作用 |
|---|---|
| `projects` | 作品设定、风格样本 |
| `characters` | 人物卡，含 `knows` / `doesnt_know` 信息边界 |
| `threads` | 明线/支线/伏笔，含计划回收章与逾期判定 |
| `chapters` | 章纲（JSON）+ 正文 + 状态门禁 |
| `runs` | 一次生成任务 |
| `steps` | 任务内的节点，落盘可续跑 |
| `llm_calls` | 每次模型调用：token、耗时、重试次数、错误 |

## SSE 事件协议

```
{"type":"run","runId":"...","chapterIdx":1}
{"type":"step","name":"outline","status":"running"}
{"type":"context","step":"outline","sections":[...],"totalTokens":812,"budget":12000}
{"type":"outline","data":{...},"chapterId":"..."}
{"type":"delta","text":"……"}
{"type":"usage","usage":{"promptTokens":900,"completionTokens":1200}}
{"type":"done","words":2600}
{"type":"error","message":"..."}
```

## 环境说明

- Windows 上 pnpm 建符号链接会栈溢出，已在 `pnpm-workspace.yaml` 固定 `nodeLinker: hoisted`。
- `pnpm build` 需要能 fork 子进程（Next 的静态生成），在受限沙箱里会报 `spawn EPERM`。

## 下一步

1. 人物卡编辑 UI（当前只有表结构，靠直接写库）
2. RAG：范文库 / 设定库 / 历史摘要三个 collection，接检索
3. `critique` skill：OOC、信息越界、线索冲突的结构化自检
4. Eval：20 条黄金样本 + 自动打分，改 prompt 前先跑回归
