# wellspring-web 架构与实现约定

本文是 0.4.0 重写的团队工作契约：后端接口、流协议、数据模型、前端状态与设计语言。
所有参与者以本文为准；需要改契约时先改本文并通知 Lead。

## 1. 目标与范围

在浏览器里与 Wellspring Agent 对话的插件。参考旧插件（`~/wellspring-web-1.21.1.zip`）的
**逻辑**（会话持久化、SSE 续接、停止/插话、提问/审批、工作区、模型选择），界面与交互完全重做。

v0.4.0 范围：

- 流式对话（正文 / 思考 / 工具过程 / 步骤），可停止、可插话
- Agent 提问（`ask`）与提权审批（`approval`）的网页内应答
- 会话持久化 + 刷新/断线续接（服务端事件缓冲）
- 会话列表、重命名、删除；工作区选择（宿主工作区注册表 + 原生目录选择器）
- 模型 / 推理强度 / 权限的会话级选择
- Markdown 渲染、代码块复制、`@` 引用工作区文件
- 亮/暗主题、响应式（桌面三栏、窄屏抽屉）
- 插件自带静态前端（Vite 构建，产物提交到 `www/`，运行期由插件 HTTP 直接下发）

不做：密码/登录（由 wellspring-gateway 统一登录）、供应商 Key 管理、插件安装管理、Web 扩展系统。

## 2. 运行形态

```text
浏览器 ──▶ wellspring-gateway(8780, 登录/TLS) ──▶ 127.0.0.1:8787  wellspring-web（本插件）
      └─▶ 直连 127.0.0.1:8787（gateway 会话 cookie 校验，302 去网关登录）
```

- 插件通过 `api.http.createServer` 监听 loopback（默认 `127.0.0.1:8787`），启动时向网关注册
  `wellspring-gateway:upstream:register`，前缀默认 `/web`（stripPrefix 打开，所以插件看到的是去掉前缀的路径）。
- 前端所有请求都用**相对路径**（`./assets/...`、`api/...`）；index.html 由服务端按
  `x-forwarded-prefix` 注入 `<base href="/web/">`（直连为 `/`），所以直连端口和网关前缀两种入口
  都能工作。页面用哈希路由（`#/c/<id>`）表示当前会话。
- 鉴权：经网关的请求信任 `x-wellspring-user`（先校验 Host 白名单）；直连端口用网关会话快照校验
  （现有 `src/session.ts` 保留）。所有 `/api/*` 都要求已登录，未登录 401（页面 302 登录）。
- 插件需要 `hostApi`: `logger`, `fs`, `http`, `event`, `agent`, `models`, `workspaces`, `getHost`。
  （`sandbox.hostApi` 一旦声明就**替换**默认集合，`agent` 必须显式列出，否则调用直接 reject。）

## 3. 仓库结构

```text
index.ts                 插件入口：配置、静态/接口服务、网关注册、生命周期
src/
  config.ts              配置解析（host/port/routePrefix/allowedHosts/wwwDir/spaFallback/limits）
  session.ts             网关会话校验（既有）
  sso-client.ts          网关 SSO 快照校验（既有）
  static.ts              静态文件服务（既有，改：根为插件自带 www、SPA 回退、主题注入、缓存头）
  assets.ts              内置 www 的定位与主题模板（替换原 seed 逻辑）
  chat-types.ts          后端共享类型（会话记录、流事件、请求体）
  chat-store.ts          会话持久化：index.json + conversations/<id>.json、规范化、限额
  chat-runtime.ts        运行中的轮次：事件缓冲、订阅者、续接、停止/插话、提问/审批
  security.ts            请求体限制、CSRF/同源校验、响应辅助、缓存与安全头
  router.ts              HTTP 路由分发（静态 + /api/*）
  api/
    state.ts             /api/bootstrap、/api/models*
    conversations.ts     会话 CRUD、active、running
    chat.ts              /api/conversations/:id/chat|resume|stop|interject
    answers.ts           /api/asks/:id、/api/approvals/:id
    files.ts             /api/files、/api/workspaces*、/api/files/open
frontend/                Vue 3 + Vite 源码（不进入插件 zip）
www/                     Vite 构建产物（提交到仓库，进入插件 zip）
test/                    node --test 单测
docs/                    本文档
```

文件所有权：

| 范围 | 负责人 |
| --- | --- |
| `src/chat-types.ts`、`index.ts` 集成、`README.md`、提交 | Lead |
| `src/chat-store.ts`、`src/chat-runtime.ts` | backend-core |
| `src/router.ts`、`src/security.ts`、`src/api/*`、`src/static.ts`、`src/assets.ts`、`src/config.ts` | backend-http |
| `frontend/` 壳层：`index.html`、`vite.config.ts`、`src/main.ts`、`src/App.vue`、`src/api.ts`、`src/store.ts`、`src/style.css`、`src/components/layout/*`、`src/components/composer/*`、`src/components/settings/*`、`src/views/*` | frontend-app |
| `frontend/src/components/chat/*`、`frontend/src/lib/markdown.ts`、`frontend/src/lib/blocks.ts` | frontend-chat |
| `scripts/e2e*.mjs`、`test/e2e/*`、浏览器截图验证 | verify |

## 4. HTTP API

统一前缀 `/api`，JSON 请求/响应；错误统一 `{ "error": "中文说明", "code"?: "..." }`。
除 `GET /__web/health` 外都要求登录。

### 4.1 状态与模型

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/__web/health` | — | `{status,sso,user,version}`（免登录） |
| GET | `/api/bootstrap` | — | 见下 |
| GET | `/api/models` | — | `{models: HostModelsState \| null}` |
| POST | `/api/models/active` | `{providerId, model, reasoning}` | `{models}`（宿主全局默认；新会话沿用） |
| GET | `/api/workspaces` | — | `{workspaces: Workspace[]}` |
| POST | `/api/workspaces` | `{root?: string, name?: string}` 或 `{pick: true}` | `{workspace, workspaces}` |
| DELETE | `/api/workspaces/:id` | — | `{ok, workspaces}` |
| POST | `/api/workspaces/validate` | `{root}` | `HostWorkspaceCheck` |
| GET | `/api/files?root=<abs>&q=<query>` | — | `HostWorkspaceFilesResult` |
| POST | `/api/files/open` | `{path, mode?: "default"\|"reveal"}` | `{ok: true}` |

`GET /api/bootstrap` 响应：

```ts
{
  version: string                     // 插件版本
  user: string | null                 // 网关用户名
  host: { status, platform, arch, node, cwd, home? }   // getHost()
  models: HostModelsState | null      // 无 models 权限时为 null
  workspaces: Workspace[]
  conversations: ConversationSummary[]
  activeId: string | null
  running: string[]                   // 正在跑一轮的会话 id
  limits: { maxMessageChars, maxReferences, maxBodyBytes, maxConversations, maxConversationChars }
}
```

### 4.2 会话

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/conversations` | — | `{conversations, activeId}` |
| POST | `/api/conversations` | `{cwd?, workspaceId?, title?, permission?, provider?, model?, reasoning?}` | `{conversation}` |
| GET | `/api/conversations/:id` | — | `{conversation, running: boolean}` |
| PATCH | `/api/conversations/:id` | 可选字段 `{title?, cwd?, workspaceId?, permission?, provider?, model?, reasoning?}` | `{conversation}` |
| DELETE | `/api/conversations/:id` | — | `{ok: true}` |
| POST | `/api/conversations/:id/active` | — | `{ok: true, activeId}`（记住上次打开的会话） |
| GET | `/api/running` | — | `{running: [{conversationId}]}` |

会话 id：`c` + 12 位 base36 随机串（`/^c[a-z0-9]{8,20}$/`）。`cwd` 为 `null` 时用宿主当前目录。

`cwd` / `workspaceId` 解析规则（POST 与 PATCH 相同）：

- `workspaceId` 非空时从宿主工作区注册表（`api.workspaces.list()`）取对应 `root` 作为 `cwd`；
  id 不存在 → `400 {"error":"工作区不存在","code":"workspace-not-found"}`
- 同时给 `cwd` 时以 `cwd` 为准（`workspaceId` 仍记录）；只给 `workspaceId` 时用它解析出的 root 覆盖 `cwd`
- 显式 `cwd` 与解析出的 root 都先经 `api.agent.validateWorkspace()` 校验：不可用 →
  `400 {"error":"工作区不可用：<原因>","code":"workspace-unavailable"}`；宿主调用失败 → `502 {"error":"宿主调用失败","code":"host-error"}`
- POST/PATCH 响应里的 `conversation` 都是完整会话（含 `messages`）

### 4.3 对话流（SSE）

`POST /api/conversations/:id/chat`

```json
{
  "message": "string，1..32000 字符，trim 后非空",
  "references": ["相对工作区路径，≤20 条，每条 ≤512"],
  "permission": "read-only | workspace-write | danger-full-access",
  "provider": "可选，覆盖会话设置",
  "model": "可选",
  "reasoning": "可选：off | low | high | max"
}
```

响应 `text/event-stream; charset=utf-8`，`cache-control: no-store`，`x-accel-buffering: no`，
每 15 秒一行 `: ping`。每个事件一行 `data: <json>`，事件对象都有 `type`：

| type | 载荷 | 说明 |
| --- | --- | --- |
| `accepted` | `{conversationId, userMessageId, assistantMessageId, at}` | 首个事件：已落库，开始跑 |
| `session` | `{sessionId, turn?}` | 宿主会话 id，收到后会话记录里保存 |
| `step` | `{turn, step}` | 每一步开始 |
| `delta` | `{text}` | 正文增量 |
| `reasoning` | `{text}` | 思考增量 |
| `tool` | `{id,name,phase:"start"\|"end",arguments?,ok?,result?,truncated?}` | 工具调用 |
| `ask` | `{request:{askId,question,options?}}` 或 `{request:null, askId}` | Agent 提问；回答后重放会变成 null |
| `approval` | `{request:{approvalId,command,argv,cwd,...}}` 或 `{request:null, approvalId}` | 提权审批；同上 |
| `steer` | `{text, at}` | 插话回显 |
| `sandbox-prepare` | `{phase, workspaceDir?, elapsedMs?, error?}` | 准备沙盒工作区 |
| `stopped` | `{at}` | 本轮被用户停止 |
| `done` | `{sessionId,turn,steps,reply,model,usage}` | 正常完成（终止事件） |
| `error` | `{error, code?}` | 失败（终止事件） |
| `truncated` | `{}` | 事件缓冲超限，刷新后无法续接本轮 |
| `replaced` | `{}` | 同一会话开始了新一轮，旧流关闭 |
| `resume` | `{active, from, total}` | 仅在 `resume` 流开头 |

`done.error.stopped.truncated.replaced` 是终态事件。

`GET /api/conversations/:id/resume?since=<n>&peek=1`

- `peek=1`：恒返回探测形状 `200 application/json` `{ok:true, active, total, done, truncated}`；
  无轮次或已过期时为 `{ok:true, active:false, total:0, done:true, truncated:false}`
- 非 peek 且无进行中轮次：`200 application/json` `{ok:false, active:false, error:"没有可续接的回复"}`
- 否则 `text/event-stream`：先写 `{type:"resume",active,from,total}`（不占缓冲下标），
  再重放 `events.slice(since)`（`since` 越界则从 0 全量），未结束则继续推实时事件 + ping。

`POST /api/conversations/:id/stop` → `{ok:true, stopped:boolean}`（幂等；调用
`api.agent.stop(sessionId)`，并在流里发 `stopped`）。

`POST /api/conversations/:id/interject` `{"message":"..."}` → `{ok:true, accepted:boolean}`；
轮次已结束返回 `409`。

`POST /api/asks/:askId` `{answer}` → `{ok:true, accepted:boolean, stale:boolean}`。
`POST /api/approvals/:approvalId` `{approved:boolean}` → 同上。

## 5. 数据模型

`api.fs` 根 = 插件数据目录，会话数据放在 `chat/` 子目录（不碰旧插件留下的 `www/`、`workspaces/` 等）：

```text
<pluginData>/chat/
  index.json                 { v:1, activeId: string|null, conversations: Summary[] }
  conversations/<id>.json    StoredConversation
```

```ts
type Permission = "read-only" | "workspace-write" | "danger-full-access"

interface Usage {
  inputTokens: number; outputTokens: number
  cacheReadTokens?: number; cacheWriteTokens?: number
  reasoningTokens?: number; contextTokens?: number
}

interface ConversationSummary {
  id: string; title: string; createdAt: number; updatedAt: number
  sessionId: string | null
  cwd: string | null            // null = 宿主当前目录
  workspaceId: string | null
  provider: string | null; model: string | null; reasoning: string | null
  permission: Permission
  turns: number; steps: number
  usage: Usage | null
  last: { role: "user" | "assistant"; text: string; at: number; status?: MessageStatus } | null
}

interface StoredConversation extends ConversationSummary {
  v: 1
  messages: StoredMessage[]
}

interface StoredMessage {
  id: string
  role: "user" | "assistant"
  at: number
  text: string                     // 用户消息正文；助手消息=已拼接的正文（不含思考/工具）
  blocks: Block[]                  // 助手消息按发生顺序的过程块；用户消息为 []
  status: "done" | "stopped" | "error" | "streaming" | "interrupted"
  error?: string
  usage?: Usage
  model?: string
  turn?: number; steps?: number
  startedAt?: number; endedAt?: number
}

type Block =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; startedAt: number; endedAt: number | null }
  | { type: "tool"; id: string; name: string; phase: "start"|"end"; arguments?: string;
      ok?: boolean; result?: string; truncated?: boolean;
      startedAt: number; endedAt: number | null; status: "running"|"ok"|"error" }
  | { type: "steer"; text: string; at: number }
  | { type: "ask"; askId: string; question: string; options: string[];
      answer: string | null; at: number }
  | { type: "approval"; approvalId: string; command: string; argv: string[]; cwd: string;
      currentPermission?: string; requestedPermission?: string; justification?: string;
      network?: boolean; background?: boolean; stdin?: string; timeoutMs?: number;
      approved: boolean | null; at: number }
  | { type: "note"; text: string; at: number; tone?: "info"|"warn" }
```

规则：

- 助手消息的正文在 `text` 与 `{type:"text"}` 块之间同步：流式期间只维护块，收尾时把正文块拼进 `text`。
  前端渲染以 `blocks` 为准；`text` 用于列表摘要与导出。
- 会话/消息限额：会话最多 100 个；单会话正文（含过程块文本）最多 600000 字符，超出丢弃最早消息；
  单条消息正文最多 32000 字符；流事件缓冲每轮最多 4MB（超出发 `truncated`，实时推送不中断）。
- 写入串行化（单写队列），先写 `conversations/<id>.json` 再更新 `index.json`；
  `updatedAt` 每次变更递增。
- 读到损坏/未知版本的文件：跳过并 warning，不影响其它会话。
- 旧插件数据（`www/`、`workspaces/`、`auth.json`、`model-context.json` 等）不再使用，也不删除。

## 6. 运行态状态机（chat-runtime）

每个会话最多一个进行中的轮次（`TurnState`）：
`conversationId, sessionId, events[], listeners, chars, done, stopped, truncated, startedAt, userMessageId, assistantMessageId`。

- `beginTurn`：若已有活跃轮次 → 先向旧轮次所有订阅者发 `replaced` 并关闭，新轮次替换；
  HTTP 层对同一会话的并发发消息直接 `409`（前端按钮本来就禁用）。
- 事件到达：追加序列化后的 SSE chunk 到 `events[]`；写入订阅者；更新内存中的助手消息块；
  持久化节流（每 1s 或 2 个事件，收尾时立即写）。
- 完成：写 `done` 事件，更新消息状态，持久化；保留缓冲 5 分钟（最多 8 轮）后清理。
- 停止：`api.agent.stop(sessionId)`；流里立即发 `stopped`；等宿主 `stream()` resolve 后收尾，
  保留已收正文。
- 提问/审批：转发事件；应答成功后将缓冲中对应 chunk 改写为 `request:null`（避免续接重复弹窗）。
- 宿主返回的错误映射为中文：缺 Key、工作区不可用、会话不存在、模型错误等。
- 插件进程重启后进行中的轮次丢失；已有会话仍可继续（宿主磁盘会话 + `sessionId`/`cwd` 成对复用）。

## 7. 安全

- 静态与 API 全部要求登录；`/__web/health` 例外。
- 写接口（POST/PATCH/DELETE）必须带 `x-web-request: 1` 头（跨站请求会触发预检而被浏览器拦截）。
  头名不能以 `x-wellspring-` 开头——网关代理会过滤掉客户端传入的该类头；
  有请求体时必须是 `application/json`；请求体上限 1MiB（消息 32000 字符另算）。
- 若带 `Origin`，其 host 必须等于请求 `Host`（经网关时 `Host` 已被网关保留为浏览器地址）。
- 响应头：`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、
  `X-Frame-Options: DENY`。HTML 用 CSP：
  `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
   font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'`。
  页面需要 `<base href>`（网关前缀 /web 下前端才能用相对路径请求 api/ 与 assets/），
  所以 base-uri 用 `'self'` 而不是 `'none'`；base 值来自网关的 x-forwarded-prefix，同源前缀。
  （前端不写内联脚本；内联 style 属性仅用于动态尺寸。）
- 静态资源路径规范化、隐藏文件与越界路径拒绝（沿用 `src/static.ts`）。

## 8. 前端约定

### 8.1 技术栈

Vue 3 + TypeScript + Vite；依赖只有 `vue`、`marked`、`dompurify`（构建时打进 bundle，运行期无 CDN）。
禁止 `v-html` 直接渲染未净化内容；Markdown 必须经 `marked` + `DOMPurify`（允许 `http/https/mailto` 链接，
`target=_blank` 加 `rel="noopener noreferrer"`）。构建产物 `www/` 提交到仓库，`www/` 由 Vite 生成，不手改。

### 8.2 状态

`frontend/src/store.ts` 导出单例 `store`（`reactive`）与动作函数；组件通过
`import { store, actions } from "../store"` 使用。不引入 Pinia。

```ts
interface AppState {
  ready: boolean
  error: string | null          // 首屏致命错误
  host: HostInfo | null
  models: ModelsState | null
  workspaces: Workspace[]
  conversations: ConversationSummary[]
  activeId: string | null
  conversation: Conversation | null
  running: Record<string, boolean>
  streaming: boolean            // 当前会话是否有活跃轮次
  streamSessionId: string | null
  draft: string                 // 当前会话草稿
  drafts: Record<string, string> // 按会话保存草稿（localStorage 持久）
  theme: "system" | "light" | "dark"
  sidebarOpen: boolean          // 移动端抽屉
  inspectorOpen: boolean
  settingsOpen: boolean
  toasts: Toast[]
}

interface Actions {
  bootstrap(): Promise<void>
  refreshConversations(): Promise<void>
  openConversation(id: string): Promise<void>
  newConversation(input?: { cwd?: string; workspaceId?: string }): Promise<void>
  send(text: string): Promise<void>          // 流式中 → 插话失败时回退为新一轮
  stop(): Promise<void>
  interject(text: string): Promise<boolean>
  answerAsk(askId: string, answer: string): Promise<void>
  answerApproval(approvalId: string, approved: boolean): Promise<void>
  renameConversation(id: string, title: string): Promise<void>
  deleteConversation(id: string): Promise<void>
  setPermission(p: Permission): Promise<void>
  setModel(choice: { provider?: string; model?: string; reasoning?: string }): Promise<void>
  setTheme(t: "system" | "light" | "dark"): void
  addWorkspace(input?: { pick?: boolean; root?: string }): Promise<void>
  removeWorkspace(id: string): Promise<void>
  searchFiles(q: string): Promise<FileEntry[]>
  openPath(path: string, mode?: "default" | "reveal"): Promise<void>
  toggleSidebar(open?: boolean): void
  toggleInspector(open?: boolean): void
  openSettings(open?: boolean): void
  setDraft(text: string): void
  toast(text: string, tone?: "info" | "success" | "error"): void
}
```

恢复逻辑（`send` / 页面加载）：

- 页面加载：`bootstrap()` → 打开 `activeId`；若该会话 `running`，自动 `resume`（重建最后一轮助手消息后重放）。
- `send`：乐观插入用户消息与空的助手消息；POST 流；按事件更新；结束后 `refreshConversations`。
- 流中断（网络/切后台）：保留已收内容，按 0.6→1.2→2.4s 退避重连续接 `resume?since=N`，
  3 次失败后标记 `interrupted`（刷新或点重试可再续）。刷新页面时浏览器取消的请求不算错误。
- 事件序号：客户端记录已收到的**数据事件**数量 `received`（不含注释 ping）；`resume?since=received`。
- `done.reply` 只在本地还没收到任何正文时兜底使用，不能覆盖已流式拼接的正文。

### 8.3 组件边界

- `App.vue`（frontend-app）：三栏骨架、响应式抽屉、全局对话框容器；包含 `Sidebar`、`ChatThread`、
  `Inspector`、`Composer`、`SettingsSheet`、`ToastStack`。
- `Sidebar.vue`（frontend-app）：品牌、工作区卡片、新建对话、会话列表（分组、运行中呼吸点）、
  底部用户/设置/主题。
- `Composer.vue`（frontend-app）：自适应 textarea、`@` 文件补全、模型/推理/权限胶囊菜单、
  发送/停止/插话按钮、键盘提示、草稿。
- `Inspector.vue`（frontend-app）：概览（模型、权限、cwd、轮/步、token 用量）与工具时间线。
- `SettingsSheet.vue`（frontend-app）：主题、默认模型/推理/权限、工作区管理、关于（版本/宿主）。
- `ChatThread.vue`（frontend-chat）：消息列表、滚动跟随、空状态、加载更早、流式状态条；
  读取 store，直接调用 actions（提问/审批/重试）。
- `MessageItem.vue` + `blocks/`（frontend-chat）：用户卡片/助手正文；按顺序渲染 `Block`：
  正文 Markdown、思考折叠、工具行、插话、提问卡、审批卡、note。
- `MarkdownText.vue`（frontend-chat）：marked + DOMPurify，流式节流重渲染（200ms），代码块复制。
- `Icon.vue`（Lead 提供）：`<Icon name="send" />`，内联 SVG sprite（不引外部图标库，不用 emoji）。

### 8.4 设计语言（与旧插件刻意不同）

- 概念：**工作台（Atelier）**，安静、编辑感、工程笔记气质；不是通用 AI 聊天气泡。
- 布局：左侧 288px「索引」栏；中间 760px 上限的「稿纸」；右侧 320px「上下文」栏（可折叠）。
  窄屏（<1080px）索引变抽屉，上下文变底部 sheet；输入区固定在底部。
- 色彩（亮色）：纸底 `#f6f3ec`、面 `#fffdf8`、墨 `#1d1b17`、次要 `#6f6a5f`、发丝线 `#e2dcd0`、
  主色深泉绿 `#1f6f5c`、主色浅底 `#dfeee7`、警示 `#b45309`、危险 `#b3402f`。
  暗色：底 `#12130f`、面 `#1a1b16`、墨 `#ece9df`、次要 `#a39e90`、线 `#2c2d26`、主色 `#6fbfa4`。
- 字体：界面 `system-ui` + 中文回退；品牌/空状态标题用衬线 `"Iowan Old Style", "Songti SC", Georgia, serif`；
  代码与元信息用 `ui-monospace, "JetBrains Mono", Consolas, monospace`。不请求网络字体。
- 字号：正文基准 `1rem`（16px），全站字号令牌用 rem（`--text-xs`…`--text-4xl`）；
  根字号由 `--ui-font-size`（默认 `1rem`）控制，改这一个变量即可整体缩放。
- 形状：输入区/卡片 14–18px 圆角；按钮胶囊；阴影极浅；边框 1px 发丝线。
- 动效：进入 120–180ms `cubic-bezier(.2,.7,.2,1)`，只用 transform/opacity；
  `prefers-reduced-motion` 全部关闭。
- 无障碍：正文对比度 ≥4.5:1，可点击区域 ≥36px（主按钮 44px），focus-visible 清晰，
  `aria-live="polite"` 播报流式回复，菜单支持方向键/Esc，表单有 label。

### 8.5 界面文案

中文；简短标签化（见 `comment-style` 规范：错误信息陈述事实，不寒暄）。
空状态标题「从哪里开始？」；建议卡片「梳理一个想法」「读一个目录」「写一段代码」。

## 9. 构建与验证

```bash
pnpm test                # 后端单测（node --test）
pnpm run typecheck       # 插件 TS
pnpm run build:ui        # 前端构建 → www/
pnpm run build:zip       # release/wellspring-web-<version>.zip（含 www/）
```

CI：`pnpm install --frozen-lockfile`、前端 `pnpm run build:ui`、`git diff --exit-code www`（产物必须与源码一致）。

端到端验证（verify 负责）：用 `wellspring --home <tmp> start` 起隔离实例（不同端口、gateway 关鉴权），
配一个本地 OpenAI 兼容 stub（SSE 流式返回固定内容），真实跑完：
登录状态下的 bootstrap → 新建会话 → 流式回复 → 工具事件 → 停止/插话 → 提问/审批 →
刷新续接 → 重启后继续会话；并用 headless Chrome 截图检查桌面/窄屏/暗色。

## 10. 关键事实（来自宿主 API 调研，别再翻源码）

- 没有创建会话/读历史的 API：首轮 `agent.stream` 不带 `sessionId` 即创建，id 由 `session` 事件返回；
  历史只存在宿主磁盘，供模型下一轮使用；UI 记录必须自己存。
- 会话按 `cwd` 分桶，`sessionId` 必须和创建时的 `cwd` 一起复用，否则 `SessionNotFoundError`。
- 流式 HTTP handler 必须**立即返回** `{stream:true}` 且不能 await 整轮（RPC 超时 180s）；
  handler 返回前写入的 chunk 会被缓冲后按序 flush。
- SSE 没有断连回调：客户端断开后写入被静默丢弃；靠心跳 + 显式 stop 接口。
- 宿主 `stream()` 的 Promise 在停止时也正常 resolve；是否被停止要看自己状态。
- `tool` 事件 `result` 最多 4000 字符；`ask` 5 分钟超时、`approval` 120 秒超时。
- 宿主无 contextWindow 字段：上下文占用只能展示 `usage.contextTokens`。
- `permission` 每轮传给宿主即可（宿主会 WARN 记录提权）；模型/推理同样每轮传。
- 插件 manifest `hostApi` 缺 `agent` 会让所有 `api.agent.*` reject。
