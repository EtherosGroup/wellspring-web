import type { HttpRequest, PluginApi } from "wellspring/api/host/index.ts"
import { EventEntity, eventBus, onShutdown } from "wellspring/api/host/index.ts"

import { ensureWww } from "./src/assets.ts"
import { parseWebConfig } from "./src/config.ts"
import { checkSession, gatewayHostTrusted } from "./src/session.ts"
import { createSsoClient, readSsoDiscovery, type SsoClient } from "./src/sso-client.ts"
import { serveStatic, type StaticOptions } from "./src/static.ts"

const GATEWAY_REGISTER = "wellspring-gateway:upstream:register"
const GATEWAY_UNREGISTER = "wellspring-gateway:upstream:unregister"
const HEALTH_PATH = "/__web/health"
const VERSION = "0.5.0"

/** 直连端口的会话校验模式：gateway 校验网关会话，disabled 网关鉴权已关闭，off 无网关发现文件，unavailable 发现文件异常 */
type SsoMode = "gateway" | "disabled" | "off" | "unavailable"

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

export function setup() {
    let server: { readonly host: string; readonly port: number; close(): Promise<void> } | null = null

    onShutdown(async () => {
        eventBus.publish(GATEWAY_UNREGISTER, EventEntity.create({ name: "wellspring-web" }))
        await server?.close()
        server = null
    })

    return {
        id: "wellspring-web",
        name: "Wellspring Web",
        description: "网页托管骨架：从插件数据目录 www/ 下发静态资源，经 wellspring-gateway 统一入口访问",
        version: VERSION,
        status: "ok" as const,
        deps: ["wellspring-gateway"],
        init: async (api: PluginApi) => {
            const { config, warnings } = parseWebConfig(api.pluginConfig)
            for (const warning of warnings) {
                api.logger.warn({ warning }, "网页配置项被忽略")
            }
            const seeded = await ensureWww(api.fs, config.wwwDir)
            if (seeded.created.length > 0) {
                api.logger.info(
                    { dir: config.wwwDir, created: seeded.created },
                    "已写入默认 www 占位页",
                )
            }
            const staticOptions: StaticOptions = {
                root: config.wwwDir,
                spaFallback: config.spaFallback,
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

            const handle = await api.http.createServer(
                { host: config.host, port: config.port },
                async (request: HttpRequest) => {
                    let path = "/"
                    try {
                        path = new URL(request.url, "http://localhost").pathname
                    } catch {
                        /* 交给静态服务返回 400 */
                    }
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
                        return {
                            status: 200,
                            headers: { "content-type": "application/json; charset=utf-8" },
                            body: JSON.stringify({
                                status: "ok",
                                version: VERSION,
                                user:
                                    request.headers["x-wellspring-gateway"] === "1" &&
                                    gatewayHostTrusted(request, config.allowedHosts)
                                        ? (request.headers["x-wellspring-user"] ?? null)
                                        : null,
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
                        api.logger.info(
                            {
                                host: request.headers["host"] ?? "",
                                url: request.url,
                                reason: session.reason,
                                status: session.response.status,
                            },
                            "会话未通过",
                        )
                        return session.response
                    }

                    try {
                        return await serveStatic(request, api.fs, staticOptions)
                    } catch (error) {
                        api.logger.error({ error: errorMessage(error) }, "静态资源读取失败")
                        return {
                            status: 500,
                            headers: { "content-type": "text/plain; charset=utf-8" },
                            body: "读取静态资源失败",
                        }
                    }
                },
            )
            server = handle
            eventBus.publish(
                GATEWAY_REGISTER,
                EventEntity.create({
                    name: "wellspring-web",
                    prefix: config.routePrefix,
                    target: `http://${handle.host}:${handle.port}`,
                }),
            )
            api.output.info(`Web 界面监听 ${handle.host}:${handle.port}，网关路径 ${config.routePrefix}`)
        },
    }
}
