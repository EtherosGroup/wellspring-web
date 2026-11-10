# @etheros/wellspring-web

Wellspring 的网页托管骨架插件。**0.5.0 起只保留两件事**：

1. 连接 **wellspring-gateway**：注册上游入口、复用网关登录态（网关转发信任 / 直连端口校验网关会话 cookie）
2. 下发静态资源：把插件数据目录 `www/` 下的文件通过 HTTP 服务发出去（占位页、MIME、ETag/304、目录索引、SPA 回退、路径安全）

对话界面、会话存储、Agent 调用、业务 API、前端构建等全部前端/后端逻辑已移除，网页由使用者自行编写。

## 架构

```text
浏览器
  ├─ 网关路径：http://127.0.0.1:8780/web/ ──▶ wellspring-gateway（登录/TLS）
  │                                            └─▶ 127.0.0.1:8787 wellspring-web（注入 x-wellspring-user）
  └─ 直连端口：http://127.0.0.1:8787/      ──▶ wellspring-web（校验 wellspring_session cookie）
                                                    │
                                                    └─ 静态：<dataDir>/plugin-data/wellspring-web/www/
```

- 插件用宿主原语 `api.http.createServer` 监听 loopback（默认 `127.0.0.1:8787`）
- 启动时通过事件总线把地址注册给网关（`wellspring-gateway:upstream:register`），网关路径默认 `/web`
- 经网关的请求已由网关完成鉴权，网关把用户放在 `x-wellspring-user` 头里；直连端口的请求读网关的
  `sso.json` / `sessions.json` 本地校验会话 cookie（需要 `wellspring-gateway` >= 0.5.0）

## 安装与加载

需要宿主 `@xyit/wellspring` >= 1.7.6、`wellspring-gateway` >= 0.5.0。

```bash
wellspring plugin link "$PWD"          # 本地开发
# 或 wellspring plugin install npm:@etheros/wellspring-web

wellspring start
```

打开 `http://127.0.0.1:8780/web`（先登录网关），或直连 `http://127.0.0.1:8787/`。

## 放你的网页

```text
<dataDir>/plugin-data/wellspring-web/www/
├── index.html
└── ...（你自己的页面、脚本、样式、静态资源）
```

两种用法：

- **直接写文件**：把任何静态站点放进去即可，改完刷新生效
- **用仓库自带的前端**：`frontend/` 是 Vue 3 + TypeScript + SCSS 的 Vite 起始项目，
  开发用 `pnpm dev:ui`，构建后 `pnpm sync:web` 把 `frontend/dist` 同步到上面的目录（见「开发」）

- 首次启动时如果 `www/` 不存在或缺少 `index.html`，写入一份占位页；**已存在的文件不会被覆盖**
- 每次请求都读盘，改完刷新即生效，不需要重启插件
- 经网关访问时页面在 `/web/` 前缀下：页面内静态引用建议用相对路径（`./app.js`）或自行处理前缀；
  网关会把前缀放在请求头 `x-forwarded-prefix` 里转发给插件
- 需要自己的接口时，在 `index.ts` 的 HTTP handler 里加路由（静态服务之外的分支），
  自行做参数校验与 CSRF 防护（0.5.0 已不含任何 API/写接口/CSRF 逻辑）

## 访问与登录

| 入口     | 地址                         | 登录方式                                                          |
| -------- | ---------------------------- | ----------------------------------------------------------------- |
| 网关路径 | `http://127.0.0.1:8780/web/` | 网关 `/login`；登录后网关转发请求并注入用户头                     |
| 直连端口 | `http://127.0.0.1:8787/`     | 同一个 `wellspring_session` cookie；未登录 302 到网关登录页并回跳 |

- 会话 cookie 是 host-only：同一主机（如 `127.0.0.1`）任意端口共享，`127.0.0.1` 与 `localhost` 不互通
- 直连要求与网关同协议：网关是 https 时直连 http 端口返回 `503 直连端口需与网关同协议`
- 页面请求未登录时 302 到网关 `/login?redirect=<当前地址>`，登录后回到原地址
- 非页面请求（`Accept` 不含 HTML）未登录返回 `401 {"error":"unauthorized"}`；`GET /__web/health` 不需要登录
- 会话快照读不到时直连端口返回 `503 会话校验不可用`；同一 token 短时间重复校验失败返回
  `503 会话状态不同步`，避免与网关回跳形成重定向循环
- 伪造的网关头在 Host 不在白名单时返回 `403 Host 不受信任`（防 DNS rebinding）
- `GET /__web/health` 返回 `{ status, version, user, sso, allowedHosts }`，`sso` 为
  `gateway`（校验网关会话）/ `disabled`（网关鉴权关闭）/ `off`（读不到网关发现文件）/
  `unavailable`（发现文件损坏，直连拒绝服务）

## 配置

`<configDir>/plugins/wellspring-web.json`，全部可选：

```json
{
    "host": "127.0.0.1",
    "port": 8787,
    "routePrefix": "/web",
    "wwwDir": "www",
    "spaFallback": false,
    "allowedHosts": ["127.0.0.1", "localhost", "[::1]"]
}
```

| 字段           | 默认        | 说明                                                                   |
| -------------- | ----------- | ---------------------------------------------------------------------- |
| `host`         | `127.0.0.1` | 监听地址                                                               |
| `port`         | `8787`      | 监听端口，`0` 为随机端口                                               |
| `routePrefix`  | `/web`      | 注册到网关的路径前缀                                                   |
| `wwwDir`       | `www`       | 插件数据目录内的静态资源目录（相对路径，不允许 `..`/反斜杠）           |
| `spaFallback`  | `false`     | 找不到文件且接受 HTML 时回退 `index.html`                             |
| `allowedHosts` | loopback    | 信任网关头时校验的 Host 主机名；自定义项追加到默认项（局域网 IP、域名） |

网关侧不需要写路由：插件启动后自动注册，访问 `http://127.0.0.1:8780/web`（先登录网关）。

## 静态服务行为

- GET / HEAD；目录路径自动补 `/` 并返回其 `index.html`
- 按扩展名返回 MIME；文本资源带 `charset=utf-8`，二进制用 base64 传入；`x-content-type-options: nosniff`
- `ETag` + `If-None-Match` 支持 304；HTML 用 `no-cache`，其它资源 `max-age=300`
- 隐藏文件（`.` 开头）、越界路径、非法编码不对外提供

## 与网关的关系

- `setup().deps` 必须声明 `wellspring-gateway`：加载器保证网关先初始化，注册事件与 `api.pluginData` 可用
- `sandbox.hostApi` 需要 `logger`、`fs`、`http`、`event`：`http` 监听端口，`fs` 经 `api.pluginData`
  读网关数据目录，`event` 注册上游
- `src/sso-client.ts` 复制自 `@xyit-team/wellspring-gateway` 的 `src/sso-client.ts`，只依赖
  `node:crypto`，在插件进程内本地校验会话，不需要出网权限；升级网关时同步该文件
- 经网关的请求只信任网关注入的 `x-wellspring-*` 头；信任前校验请求 `Host` 主机名在
  `allowedHosts` 内，防 DNS rebinding
- 局域网/自定义域名访问时把该主机名加入 `allowedHosts`，否则网关路径返回 403、直连登录回退到网关地址

## 开发

```bash
pnpm install             # 需要 pnpm >= 11（allowBuilds 语义；CI 与开发基线 12.14.0）
pnpm run typecheck
pnpm test                # session 校验 / 静态服务 / www 占位页 / 配置 单测
pnpm run build:zip       # release/wellspring-web-<version>.zip

wellspring plugin link "$PWD"
wellspring start
```

### 前端（`frontend/`）

仓库自带一个 Vue 3 + Vite 起始项目：TypeScript、SCSS（`src/styles/`），
**没有**安装 Vue DevTools 插件（`vite-plugin-vue-devtools`）。

```bash
pnpm install              # 根目录安装，包含 frontend workspace（单份 pnpm-lock.yaml）
pnpm dev:ui               # http://127.0.0.1:5178/，/__web 与 /api 代理到 127.0.0.1:8787
pnpm typecheck:ui
pnpm build:ui             # 构建到 frontend/dist
pnpm sync:web             # 同步 frontend/dist → <dataDir>/plugin-data/wellspring-web/www
pnpm sync:web --clean     # 先清空目标目录再同步（产物带 hash 时推荐）
```

- 开发服务器依赖插件后端：先 `wellspring start` 并经网关登录；浏览器用 `127.0.0.1:5178`
  访问（会话 cookie 是 host-only，`localhost` 不互通）
- 构建用相对 base：同一份产物可直连 `8787`，也可经网关 `/web/` 访问（地址要带尾斜杠）
- 加依赖用 `pnpm -C frontend add <pkg>`，不要混用 npm/yarn（pnpm workspace 只有一份 lockfile）

### 目录结构

```text
index.ts             插件入口：HTTP 服务、网关注册、会话校验、静态下发
src/config.ts        配置解析
src/assets.ts        www 目录与占位页
src/static.ts        静态文件服务
src/session.ts       会话校验（网关头信任 + 直连 cookie 校验）
src/sso-client.ts    网关 SSO 快照校验（与网关同步复制）
test/                单测
frontend/            Vue 3 + TS + SCSS 起始前端（不进入插件包）
scripts/sync-web.mjs 把 frontend/dist 同步到插件数据目录
```

## 安全与限制

- 直连端口只应监听 loopback；监听地址不是 loopback 时启动日志 warning
- 会话快照是近实时镜像：网关注销/改密后本地快照会更新，磁盘持续故障时可能短暂滞后
- 网关停止时直连端口按最后一次成功写入的会话快照放行（离线设计）
- 反向代理必须保留浏览器原始 `Host`：网关用 `Host` 判断登录回跳是否同源
- 修改 `www/` 下的文件不需要重启，修改插件配置需要重启服务
- 发现文件只在启动时读取一次：网关换端口或切换 `auth.enabled` 后需要重启本插件

## 版本

- `0.5.0`：移除 0.4.0 的对话界面与全部业务逻辑（chat 存储、SSE、API、前端构建），
  只保留网关连接、登录态复用与静态资源下发；包名保持 `@etheros/wellspring-web`
- 仓库另带 `frontend/` Vue 3 + TypeScript + SCSS 起始前端与 `pnpm sync:web` 部署脚本，
  不进入插件 zip / npm 包
