# wellspring-web 端到端验证

隔离宿主 + 可脚本化 stub 模型 + HTTP/SSE 用例 + headless Chrome 真实交互。
只依赖 Node 原生模块，不新增依赖；不修改业务代码。

## 一键运行

```bash
node scripts/e2e/run.mjs               # 全量（自动新建临时 home 与动态端口）
node scripts/e2e/run.mjs --only BR1    # 只跑某组/某用例（id 前缀或名称包含）
node scripts/e2e/run.mjs --no-browser  # 跳过浏览器检查
node scripts/e2e/run.mjs --build-ui    # 先 pnpm run build:ui 再跑
node scripts/e2e/run.mjs --keep        # 保留临时 home 便于排查
```

产出：

- 报告 `/tmp/e2e-report.md`（用例矩阵、入口分组、缺陷、观察建议、宿主日志关键行）
- 截图 `/tmp/e2e-shots/<运行时间>/`（普通对话、工具折叠/展开、ask、审批批准/拒绝、停止、续接、暗色、窄屏、直连）
- 宿主/stub 日志：失败保留在临时 home，另存 `/tmp/e2e-logs/<运行时间>-{host,stub}.log`

## 组成

| 文件 | 作用 |
| --- | --- |
| `stub-model.mjs` | OpenAI 兼容 stub，按消息标记切换行为：普通文本、reasoning、工具调用、ask、审批、慢流、500、空回复、中途断流 |
| `harness.mjs` | 临时 home（config/data/work）、插件 symlink、空闲端口、stub/wellspring 进程启停、重启、健康等待、清理 |
| `lib.mjs` | HTTP 客户端、SSE 解析（received/since/peek 语义）、断言、Markdown 报告 |
| `browser.mjs` | headless Chrome + CDP：真实 UI 交互与截图、控制台/网络错误收集 |
| `run.mjs` | 用例编排与报告生成 |

也可单独起环境手动调试：

```bash
node scripts/e2e/harness.mjs          # 起实例并打印直连/网关地址，Ctrl+C 清理
pnpm run build:ui                     # 前端有改动时重建 www/
```

## 用例标记（stub 模型）

在用户消息里写标记即可触发对应行为，例如 `你好 [[stub:text]]`：

| 标记 | 行为 |
| --- | --- |
| `[[stub:text]]` | 普通流式文本「你好，我是测试模型。」（缺省） |
| `[[stub:reasoning]]` | 先 reasoning 增量再正文 |
| `[[stub:tool]]` | 调用 execute_code(pwd)，宿主执行后回正文 |
| `[[stub:tool-multi]]` | 同一响应两个工具调用 |
| `[[stub:tool-bad]]` | 调用未知工具（工具失败路径） |
| `[[stub:ask]]` | 内置 ask 提问，应答后回正文 |
| `[[stub:approval]]` | execute_code 请求 workspace-write 提权 |
| `[[stub:steer]]` | 慢工具留插话窗口，随后慢速正文 |
| `[[stub:slow:300]]` | 慢速流，分块间隔 300ms |
| `[[stub:500]]` | HTTP 500 |
| `[[stub:empty]]` | 空回复 |
| `[[stub:error-mid]]` | 正文中途断开连接 |
| `[[stub:markdown]]` / `[[stub:long]]` | Markdown 素材 / 长文本 |

统计接口：`GET http://127.0.0.1:<stubPort>/__stub/stats`、`POST /__stub/reset`。

## 用例矩阵

- S：健康检查、静态首页/CSP、网关路由、路径穿越
- B：bootstrap 结构、经网关 bootstrap、安全头、CSRF（`x-web-request: 1`）、Origin 校验
- W：经网关入口的新建会话、流式对话、停止、插话、ask、approval、断线续接
- C：会话 CRUD、坏工作区、未知会话
- D：流式 accepted/session/delta/done、SSE 头、空/超长消息、reasoning、Markdown、多轮、并发 409、running
- E：工具 start/end、多工具、工具失败
- F/G：ask、approval 同意/拒绝、未知/重复应答幂等
- H：停止（宿主中止 + stopped 状态）、幂等、插话 steer、空闲插话 409
- I：断线 peek/resume 续接、完成态 peek、空会话 peek
- J：数据落盘（chat/index.json、conversations/<id>.json）、宿主重启后同 sessionId+cwd 继续
- L：模型列表/全局模型、工作区增删校验、文件搜索、打开参数校验
- K：模型 500/空回复/连接中断/缺 Key 的中文错误
- BR1：真实浏览器（网关入口 bootstrap → 新对话 → 普通消息 → 工具折叠/展开 → ask 回答 → 审批批准/拒绝 → 流式中停止 → 刷新后自动续接 → 暗色/窄屏/直连截图 → 控制台无 JS/CSP 报错）

## 端口与隔离

- 每个运行新建 `/tmp/wellspring-web-e2e-*` 作为 `--home`，端口由 `listen(0)` 动态分配，不使用 `/tmp/wshome`、8780/8787 等既有实例。
- 插件通过 `data/plugins` symlink 指向：本仓库、`../wellspring-gateway`、宿主已安装的 `wellspring-core`（可用 `E2E_CORE_PLUGIN` / `E2E_GATEWAY_PLUGIN` 覆盖）。
- 浏览器检查每次用随机调试端口，启动前清理残留的 `wellspring-chrome-*` 进程。
