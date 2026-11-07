import type { HttpRequest, PluginApi } from "wellspring/api/host/index.ts"
import { EventEntity, eventBus, onShutdown } from "wellspring/api/host/index.ts"

import { ensureWww } from "./src/assets.ts"
import { parseWebConfig } from "./src/config.ts"
import { serveStatic, type StaticOptions } from "./src/static.ts"

const GATEWAY_REGISTER = "wellspring-gateway:upstream:register"
const GATEWAY_UNREGISTER = "wellspring-gateway:upstream:unregister"
const HEALTH_PATH = "/__web/health"

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
        description: "网页界面：从插件数据目录 www/ 下发静态资源，经 wellspring-gateway 统一入口访问",
        version: "0.1.0",
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
                    "已写入默认 www 资源",
                )
            }
            const staticOptions: StaticOptions = {
                root: config.wwwDir,
                spaFallback: config.spaFallback,
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
                        return {
                            status: 200,
                            headers: { "content-type": "application/json; charset=utf-8" },
                            body: JSON.stringify({
                                status: "ok",
                                user: request.headers["x-wellspring-user"] ?? null,
                            }),
                        }
                    }
                    try {
                        return await serveStatic(request, api.fs, staticOptions)
                    } catch (error) {
                        api.logger.error(
                            { error: error instanceof Error ? error.message : String(error) },
                            "静态资源读取失败",
                        )
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
