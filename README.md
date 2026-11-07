# @xyit-team/wellspring-web

Wellspring 网页界面插件：从插件数据目录的 `www/` 下发静态资源；经网关路径访问时复用网关登录，直连插件端口时用网关会话 cookie 自动认证。

## 架构

```text
浏览器
  ├─ 网关路径：http://127.0.0.1:8780/web/… ──▶ wellspring-gateway（登录/TLS）
  │                                            └─▶ 127.0.0.1:8787 wellspring-web（注入 x-wellspring-user）
  └─ 直连端口：http://127.0.0.1:8787/…      ──▶ wellspring-web（校验 wellspring_session cookie）
                                                    │
                                                    └─ 读 <dataDir>/plugin-data/wellspring-web/www/
```

- 插件用宿主原语 `api.http.createServer` 监听 loopback（默认 `127.0.0.1:8787`）
- 启动时通过事件总线把地址注册给网关（`wellspring-gateway:upstream:register`），网关路径默认 `/web`
- 经网关的请求已由网关完成鉴权，网关把用户放在 `x-wellspring-user` 头里，插件直接信任
- 直连端口的请求没有这些头，插件读网关的 `sso.json` / `sessions.json` 本地校验会话 cookie（需要 `wellspring-gateway` >= 0.5.0）

## 访问与登录

| 入口     | 地址                         | 登录方式                                                          |
| -------- | ---------------------------- | ----------------------------------------------------------------- |
| 网关路径 | `http://127.0.0.1:8780/web/` | 网关 `/login`；登录后网关转发请求并注入用户头                     |
| 直连端口 | `http://127.0.0.1:8787/`     | 同一个 `wellspring_session` cookie；未登录 302 到网关登录页并回跳 |

- 会话 cookie 是 host-only：同一主机（`127.0.0.1`）任意端口共享，`127.0.0.1` 与 `localhost` 不互通
- 直连要求与网关同协议：TLS 的 `Secure` cookie 不会发给 http 端口；网关是 https 时直连 http 端口返回 `503 直连端口需与网关同协议`
- 页面请求未登录时 302 到网关 `/login?redirect=<当前地址>`，登录后回到原地址；地址格式为 `host[:port]/path`，如 `127.0.0.1:8787/`、`192.168.31.138:8787/`
- 登录地址的主机名沿用浏览器当前使用的主机名（如 8787 用 `192.168.31.138` 访问，登录跳 `192.168.31.138:<网关端口>`），网关需监听该地址
- `Accept` 为 `application/json` 等非页面类型时未登录返回 `401 {"error":"unauthorized"}`；浏览器默认 `*/*` 按页面处理
- 静态资源同样需要登录；只有 `GET /__web/health` 不需要
- 会话快照读不到时直连端口返回 `503 会话校验不可用`，不跳登录页
- 同一会话短时间重复校验失败（快照滞后于网关会话）返回 `503 会话状态不同步`，不再回跳，避免重定向循环；只对页面请求生效（API 始终 401），登录成功或网关补写完成后恢复，5 分钟内重复失败会持续 503
- 伪造的网关头在 Host 不在白名单时返回 `403 Host 不受信任`（防 DNS rebinding；`/__web/health` 除外）
- `GET /__web/health` 返回 `{ status, user, sso }`，`sso` 为 `gateway`（校验网关会话）/ `disabled`（网关鉴权关闭）/ `off`（读不到网关发现文件）/ `unavailable`（发现文件损坏，直连拒绝服务）
- `wellspring-gateway` 0.4.x 有 `sso.json`，会话校验可用，但不支持 `redirect` 参数，登录后回跳失效（停在网关页面），建议 >= 0.5.0；0.4.x 无法自动识别，< 0.4.0 读不到 `sso.json` 时启动日志 warning
- 新版网关的数据目录有 `sessions.json` 但 `sso.json` 缺失或损坏时，直连端口按失败关闭处理（503），经网关的入口不受影响

## 静态资源目录

```text
<dataDir>/plugin-data/wellspring-web/www/
├── index.html
├── style.css
└── app.js
```

- 首次启动时如果 `www/` 不存在或缺少文件，写入一份默认骨架；**已存在的文件不会被覆盖**
- 修改 `www/` 下的文件即生效（每次请求都读盘），不需要重启服务、不需要重装插件
- 升级插件只会补齐缺失的默认文件，不会动用户改过的内容

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

| 字段          | 默认        | 说明                                       |
| ------------- | ----------- | ------------------------------------------ |
| `host`        | `127.0.0.1` | 监听地址                                   |
| `port`        | `8787`      | 监听端口，`0` 为随机端口                   |
| `routePrefix` | `/web`      | 注册到网关的路径前缀                       |
| `wwwDir`      | `www`       | 插件数据目录内的静态资源目录               |
| `spaFallback` | `false`     | 找不到文件且接受 HTML 时回退 `index.html`  |
| `allowedHosts` | loopback   | 信任网关头时校验的 Host 主机名；默认 `127.0.0.1` / `localhost` / `[::1]`，自定义项追加到默认项（局域网 IP、自定义域名） |

网关侧不需要写路由：插件启动后自动注册，访问 `http://127.0.0.1:8780/web`（先登录网关）。

## 静态服务行为

- 除 `/__web/health` 外的请求先过会话校验，再进入静态服务
- GET / HEAD；目录路径自动补 `/` 并返回其 `index.html`
- 按扩展名返回 MIME；文本资源带 `charset=utf-8`，二进制用 base64 传入
- `ETag` + `If-None-Match` 支持 304；HTML 用 `no-cache`，其它资源 `max-age=300`
- 隐藏文件（`.` 开头）、越界路径、非法编码不对外提供

## 与网关的关系

- `setup().deps` 必须声明 `wellspring-gateway`：加载器保证网关先初始化，注册事件与 `api.pluginData` 可用
- `sandbox.hostApi` 至少包含 `http`、`fs`、`event`：`http` 监听端口，`fs` 经 `api.pluginData` 读网关数据目录，`event` 注册上游
- `src/sso-client.ts` 复制自 `@xyit-team/wellspring-gateway@0.5.0` 的 `src/sso-client.ts`，只依赖 `node:crypto`，在插件进程内本地校验会话，不需要出网权限；升级网关时同步该文件
- 经网关的请求只信任网关注入的 `x-wellspring-*` 头；信任前校验请求 `Host` 主机名在 `allowedHosts` 内，防 DNS rebinding 伪造头
- 经网关访问或直连端口登录跳转使用 `127.0.0.1` / `localhost` 以外的地址（局域网 IP、自定义域名）时，把该主机名加入 `allowedHosts`，否则网关路径返回 403、直连登录回退到网关地址（不带 redirect）
- 局域网地址访问直连端口：网关要监听该地址（`host: "0.0.0.0"` 或指定 IP），浏览器先跳同主机的网关登录页拿 cookie，再回到直连端口
- 登录地址只对 `allowedHosts` 内的请求 Host 替换主机名，避免 DNS rebinding 域名拿到会话 cookie

## 限制

- 直连端口只应监听 loopback，不要把 `8787` 暴露到本机之外；监听地址不是 loopback 时启动日志 warning
- 会话快照是近实时镜像：网关注销/改密后本地快照会更新，磁盘持续故障时可能短暂滞后
- 网关停止时直连端口按最后一次成功写入的会话快照放行（离线设计）；会话只存在网关内存，网关重启后需要重新登录
- 反向代理必须保留浏览器原始 `Host`：网关用 `Host` 判断登录回跳是否同源，并校验登录 `POST` 的 `Origin`
- 修改 `www/` 下的文件不需要重启，修改插件配置需要重启服务
- 发现文件只在启动时读取一次：网关换端口或切换 `auth.enabled` 后需要重启本插件

## 开发

```bash
npm install
npm run typecheck
npm test              # 静态服务 + www 初始化 + 会话校验 + 配置单测
npm run build:zip     # release/wellspring-web-<version>.zip
wellspring plugin link "$PWD"
wellspring start
```

## 发布

```bash
# 改 package.json 的 version，提交后推同名 tag
git tag -a v0.3.0 -m "v0.3.0"
git push origin master refs/tags/v0.3.0
```

推 `v*` 标签触发 `release.yml`（zip + SHA256SUMS 挂 GitHub Release）与 `publish-npm.yml`
（Trusted Publishing / OIDC 发 npm，已发布版本自动跳过）。

## 后续

界面本身还没开始写：可以把前端构建产物直接输出到 `www/`，或在该目录手写页面。
页面与接口请求都会自动带上 host-only 会话 cookie；需要宿主能力（会话、模型、工作区等）时按 `hostApi` 申请，UI 通过插件自己的接口访问。
