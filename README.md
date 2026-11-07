# @xyit-team/wellspring-web

Wellspring 网页界面插件：把插件数据目录里的 `www/` 静态资源通过 `wellspring-gateway` 统一入口下发。

## 架构

```text
浏览器 ──▶ wellspring-gateway（唯一入口、登录/TLS）──▶ 127.0.0.1:8787 wellspring-web
                                                          │
                                                          └─ 读 <dataDir>/plugin-data/wellspring-web/www/
```

- 插件用宿主原语 `api.http.createServer` 监听 loopback（默认 `127.0.0.1:8787`），自己不处理登录
- 启动时通过事件总线把地址注册给网关（`wellspring-gateway:upstream:register`），对外访问走 `/web`
- 登录由网关完成，网关把 `x-wellspring-user` 头传给本插件；直接访问 loopback 端口不经过鉴权（仅本机可达）

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
    "spaFallback": false
}
```

| 字段          | 默认        | 说明                                       |
| ------------- | ----------- | ------------------------------------------ |
| `host`        | `127.0.0.1` | 监听地址                                   |
| `port`        | `8787`      | 监听端口，`0` 为随机端口                   |
| `routePrefix` | `/web`      | 注册到网关的路径前缀                       |
| `wwwDir`      | `www`       | 插件数据目录内的静态资源目录               |
| `spaFallback` | `false`     | 找不到文件且接受 HTML 时回退 `index.html`  |

网关侧不需要写路由：插件启动后自动注册，访问 `http://127.0.0.1:8780/web`（先登录网关）。

## 静态服务行为

- GET / HEAD；目录路径自动补 `/` 并返回其 `index.html`
- 按扩展名返回 MIME；文本资源带 `charset=utf-8`，二进制用 base64 传入
- `ETag` + `If-None-Match` 支持 304；HTML 用 `no-cache`，其它资源 `max-age=300`
- 隐藏文件（`.` 开头）、越界路径、非法编码不对外提供
- `GET /__web/health` 返回 `{ status, user }`，便于排查网关身份透传

## 与网关的关系

消费者插件必须在 `setup().deps` 里声明 `wellspring-gateway`，加载器保证网关先初始化、注册事件不丢。
`package.json` 的 `sandbox.hostApi` 至少要包含 `http` 与 `event`。

## 开发

```bash
npm install
npm run typecheck
npm test              # 静态服务 + www 初始化单测
npm run build:zip     # release/wellspring-web-<version>.zip
wellspring plugin link "$PWD"
wellspring start
```

## 发布

```bash
# 改 package.json 的 version，提交后推同名 tag
git tag -a v0.1.1 -m "v0.1.1"
git push origin master refs/tags/v0.1.1
```

推 `v*` 标签触发 `release.yml`（zip + SHA256SUMS 挂 GitHub Release）与 `publish-npm.yml`
（Trusted Publishing / OIDC 发 npm，已发布版本自动跳过）。

## 后续

界面本身还没开始写：可以把前端构建产物直接输出到 `www/`，或在该目录手写页面。
需要宿主能力（会话、模型、工作区等）时按 `hostApi` 申请，UI 通过插件自己的接口访问。
