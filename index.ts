import type {
    HttpRequest,
    HttpServerHandle,
    PluginApi,
} from "wellspring/api/host/index.ts"
import {
    EventEntity,
    eventBus,
    getHost,
    onShutdown,
    SANDBOX_PREPARE_EVENT,
    type SandboxPrepareEvent,
} from "wellspring/api/host/index.ts"

import { ChatRuntime } from "./src/chat-runtime.ts"
import { ChatStore } from "./src/chat-store.ts"
import { parseWebConfig } from "./src/config.ts"
import { createRouter } from "./src/router.ts"
import { checkSession, gatewayHostTrusted } from "./src/session.ts"
import { createSsoClient, readSsoDiscovery, type SsoClient } from "./src/sso-client.ts"

const GATEWAY_REGISTER = "wellspring-gateway:upstream:register"
const GATEWAY_UNREGISTER = "wellspring-gateway:upstream:unregister"
const HEALTH_PATH = "/__web/health"
const VERSION = "0.4.0"

/** 直连端口的会话校验模式：gateway 校验网关会话，disabled 网关鉴权已关闭，off 无网关发现文件，unavailable 发现文件异常 */
type SsoMode = "gateway" | "disabled" | "off" | "unavailable"

function requestPath(url: string): string {
    try {
        return new URL(url, "http://localhost").pathname
    } catch {
        return "/"
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

export function setup() {
    let server: HttpServerHandle | null = null
    let runtime: ChatRuntime | null = null
    let unsubscribePrepare: (() => void) | null = null

    onShutdown(async () => {
        const stopPreparing = unsubscribePrepare
        unsubscribePrepare = null
        stopPreparing?.()
        eventBus.publish(GATEWAY_UNREGISTER, EventEntity.create({ name: "wellspring-web" }))
        const currentRuntime = runtime
        runtime = null
        await currentRuntime?.dispose().catch(() => undefined)
        const currentServer = server
        server = null
        await currentServer?.close().catch(() => undefined)
    })

    return {
        id: "wellspring-web",
        name: "Wellspring Web",
        description: "网页界面：在浏览器里与 Agent 对话，经 wellspring-gateway 统一入口访问",
        version: VERSION,
        status: "ok" as const,
        deps: ["wellspring-gateway"],
        init: async (api: PluginApi) => {
            const { config, warnings } = parseWebConfig(api.pluginConfig)
            for (const warning of warnings) {
                api.logger.warn({ warning }, "网页配置项被忽略")
            }
            if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(config.host)) {
                api.logger.warn(
                    { host: config.host },
                    "监听地址不是 loopback，直连端口的会话校验可被本机以外访问",
                )
            }

            /* 网关在自身数据目录写 sso.json，经依赖链的 pluginData 读取 */
            const gatewayData = await api.pluginData("wellspring-gateway")
            const discovery = await readSsoDiscovery(gatewayData)
            let sso: SsoClient | null = null
            let ssoMode: SsoMode = "off"
            let failClosed = false
            if (discovery === null) {
                /* sessions.json 存在说明网关是新版，发现文件缺失或损坏按失败关闭处理 */
                if ((await gatewayData?.exists("sessions.json")) === true) {
                    failClosed = true
                    ssoMode = "unavailable"
                    api.logger.error({}, "网关 SSO 发现文件缺失或损坏，直连端口拒绝服务")
                } else {
                    api.logger.warn({}, "未找到网关 SSO 发现文件，直连端口不做会话校验")
                }
            } else if (discovery.version !== 1) {
                failClosed = true
                ssoMode = "unavailable"
                api.logger.error(
                    { version: discovery.version },
                    "网关 SSO 发现文件版本不支持，直连端口拒绝服务",
                )
            } else if (!discovery.authEnabled) {
                ssoMode = "disabled"
            } else {
                try {
                    sso = createSsoClient({
                        gatewayUrl: discovery.url,
                        authEnabled: discovery.authEnabled,
                        cookieName: discovery.cookieName,
                        sessions: async () => await gatewayData?.readJson(discovery.sessionsFile),
                    })
                    ssoMode = "gateway"
                    api.logger.info(
                        {
                            gateway: discovery.url,
                            host: config.host,
                            allowedHosts: [...config.allowedHosts],
                        },
                        "直连端口启用网关会话校验",
                    )
                } catch (error) {
                    failClosed = true
                    ssoMode = "unavailable"
                    api.logger.error(
                        { error: errorMessage(error) },
                        "网关 SSO 客户端初始化失败，直连端口拒绝服务",
                    )
                }
            }

            const store = new ChatStore({
                fs: api.fs,
                limits: config.limits,
                logger: api.logger,
            })
            try {
                await store.load()
            } catch (error) {
                api.logger.error({ error: errorMessage(error) }, "会话索引加载失败")
            }
            runtime = new ChatRuntime({
                agent: api.agent,
                store,
                limits: config.limits,
                logger: api.logger,
            })
            const activeRuntime = runtime
            /* 沙盒准备进度从事件总线转进当前轮次的流 */
            unsubscribePrepare = eventBus.subscribe<SandboxPrepareEvent>(
                SANDBOX_PREPARE_EVENT,
                (event) => {
                    activeRuntime.injectSandboxPrepare(event.getData())
                },
            )
            const router = createRouter({
                api,
                config,
                store,
                runtime,
                version: VERSION,
                hostInfo: () => {
                    try {
                        const host = getHost()
                        const os = host.getOS()
                        return {
                            status: host.getStatus(),
                            platform: os.platform,
                            arch: os.arch,
                            node: os.node,
                            cwd: os.cwd,
                        }
                    } catch {
                        return null
                    }
                },
            })

            server = await api.http.createServer(
                { host: config.host, port: config.port },
                async (request: HttpRequest, stream) => {
                    const path = requestPath(request.url)
                    if (path === HEALTH_PATH) {
                        if (request.method !== "GET" && request.method !== "HEAD") {
                            return {
                                status: 405,
                                headers: {
                                    "content-type": "text/plain; charset=utf-8",
                                    allow: "GET, HEAD",
                                },
                                body: "不支持的请求方法",
                            }
                        }
                        const user =
                            request.headers["x-wellspring-gateway"] === "1" &&
                            gatewayHostTrusted(request, config.allowedHosts)
                                ? (request.headers["x-wellspring-user"] ?? null)
                                : null
                        return {
                            status: 200,
                            headers: { "content-type": "application/json; charset=utf-8" },
                            body: JSON.stringify({
                                status: "ok",
                                version: VERSION,
                                user,
                                sso: ssoMode,
                                allowedHosts: [...config.allowedHosts],
                            }),
                        }
                    }

                    const session = await checkSession(request, sso, {
                        allowedHosts: config.allowedHosts,
                        failClosed,
                    })
                    if (!session.ok) {
                        return session.response
                    }

                    /* 直连端口已校验会话，把用户名补进请求头副本；经网关时沿用已验证的头 */
                    const authedRequest: HttpRequest =
                        session.user === null
                            ? request
                            : {
                                  ...request,
                                  headers: { ...request.headers, "x-wellspring-user": session.user },
                              }
                    try {
                        return await router(authedRequest, stream)
                    } catch (error) {
                        api.logger.error(
                            { url: request.url, error: errorMessage(error) },
                            "网页请求处理失败",
                        )
                        return {
                            status: 500,
                            headers: { "content-type": "application/json; charset=utf-8" },
                            body: JSON.stringify({ error: "服务器内部错误" }),
                        }
                    }
                },
            )

            eventBus.publish(
                GATEWAY_REGISTER,
                EventEntity.create({
                    name: "wellspring-web",
                    prefix: config.routePrefix,
                    target: `http://${server.host}:${server.port}`,
                }),
            )
            api.output.info(`Web 界面监听 ${server.host}:${server.port}，网关路径 ${config.routePrefix}`)
        },
    }
}

