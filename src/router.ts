/*
 * HTTP 路由分发：静态资源 + /api/*
 *
 * index.ts 已处理 /__web/health、登录校验与网关头信任；这里不重复鉴权
 * 所有响应带安全头；handler 抛错统一 500
 */

import type { HttpRequest, HttpStreamContext, HttpResponse } from "wellspring/api/host/index.ts"

import { createPluginStaticFs } from "./assets.ts"
import { handleApprovalAnswer, handleAskAnswer } from "./api/answers.ts"
import { handleChat, handleInterject, handleResume, handleStop } from "./api/chat.ts"
import {
    handleCreateConversation,
    handleDeleteConversation,
    handleGetConversation,
    handleListConversations,
    handlePatchConversation,
    handleRunning,
    handleSetActiveConversation,
} from "./api/conversations.ts"
import type { ApiContext } from "./api/context.ts"
import { decodeSegment } from "./api/context.ts"
import {
    handleAddWorkspace,
    handleFiles,
    handleListWorkspaces,
    handleOpenFile,
    handleRemoveWorkspace,
    handleValidateWorkspace,
} from "./api/files.ts"
import { handleBootstrap, handleModels, handleSetActiveModel } from "./api/state.ts"
import {
    applySecurityHeaders,
    errorResponse,
    guardWrite,
    isWriteMethod,
} from "./security.ts"
import { serveStatic, type StaticFileSystem } from "./static.ts"

export interface WebRouterOptions extends ApiContext {
    /** 测试注入的内存静态 fs；默认读插件目录 www */
    readonly staticFs?: StaticFileSystem
    /** 测试注入的静态根；默认 config.wwwDir */
    readonly wwwRoot?: string
}

type RouteHandler = (
    ctx: ApiContext,
    request: HttpRequest,
    url: URL,
    params: readonly string[],
    stream: HttpStreamContext,
) => Promise<HttpResponse>

interface ApiRoute {
    readonly pattern: RegExp
    readonly methods: Readonly<Record<string, RouteHandler>>
}

function route(pattern: RegExp, methods: Readonly<Record<string, RouteHandler>>): ApiRoute {
    return { pattern, methods }
}

const ROUTES: readonly ApiRoute[] = [
    route(/^\/api\/bootstrap$/, {
        GET: (ctx, request) => handleBootstrap(ctx, request),
    }),
    route(/^\/api\/models$/, {
        GET: (ctx) => handleModels(ctx),
    }),
    route(/^\/api\/models\/active$/, {
        POST: (ctx, request) => handleSetActiveModel(ctx, request),
    }),
    route(/^\/api\/workspaces$/, {
        GET: (ctx) => handleListWorkspaces(ctx),
        POST: (ctx, request) => handleAddWorkspace(ctx, request),
    }),
    route(/^\/api\/workspaces\/validate$/, {
        POST: (ctx, request) => handleValidateWorkspace(ctx, request),
    }),
    route(/^\/api\/workspaces\/([^/]+)$/, {
        DELETE: (ctx, _request, _url, params) => handleRemoveWorkspace(ctx, params[0] ?? ""),
    }),
    route(/^\/api\/files$/, {
        GET: (ctx, _request, url) => handleFiles(ctx, url),
    }),
    route(/^\/api\/files\/open$/, {
        POST: (ctx, request) => handleOpenFile(ctx, request),
    }),
    route(/^\/api\/conversations$/, {
        GET: (ctx) => handleListConversations(ctx),
        POST: (ctx, request) => handleCreateConversation(ctx, request),
    }),
    route(/^\/api\/conversations\/([^/]+)$/, {
        GET: (ctx, _request, _url, params) => handleGetConversation(ctx, params[0] ?? ""),
        PATCH: (ctx, request, _url, params) =>
            handlePatchConversation(ctx, request, params[0] ?? ""),
        DELETE: (ctx, _request, _url, params) => handleDeleteConversation(ctx, params[0] ?? ""),
    }),
    route(/^\/api\/conversations\/([^/]+)\/active$/, {
        POST: (ctx, _request, _url, params) =>
            handleSetActiveConversation(ctx, params[0] ?? ""),
    }),
    route(/^\/api\/conversations\/([^/]+)\/chat$/, {
        POST: (ctx, request, _url, params, stream) =>
            handleChat(ctx, request, params[0] ?? "", stream),
    }),
    route(/^\/api\/conversations\/([^/]+)\/resume$/, {
        GET: (ctx, _request, url, params, stream) =>
            handleResume(ctx, url, params[0] ?? "", stream),
    }),
    route(/^\/api\/conversations\/([^/]+)\/stop$/, {
        POST: (ctx, _request, _url, params) => handleStop(ctx, params[0] ?? ""),
    }),
    route(/^\/api\/conversations\/([^/]+)\/interject$/, {
        POST: (ctx, request, _url, params) =>
            handleInterject(ctx, request, params[0] ?? ""),
    }),
    route(/^\/api\/running$/, {
        GET: (ctx) => Promise.resolve(handleRunning(ctx)),
    }),
    route(/^\/api\/asks\/([^/]+)$/, {
        POST: (ctx, request, _url, params) => handleAskAnswer(ctx, request, params[0] ?? ""),
    }),
    route(/^\/api\/approvals\/([^/]+)$/, {
        POST: (ctx, request, _url, params) =>
            handleApprovalAnswer(ctx, request, params[0] ?? ""),
    }),
]

/** 去掉末尾斜杠；保留根路径 */
function normalizePath(pathname: string): string {
    return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname
}

async function routeApi(
    ctx: ApiContext,
    request: HttpRequest,
    url: URL,
    stream: HttpStreamContext,
): Promise<HttpResponse> {
    const method = request.method.toUpperCase()
    const path = normalizePath(url.pathname)
    /* 先匹配路径：命中但方法不对返回 405，写请求校验只对命中的写方法执行 */
    for (const entry of ROUTES) {
        const match = entry.pattern.exec(path)
        if (match === null) {
            continue
        }
        const handler = entry.methods[method]
        if (handler === undefined) {
            return errorResponse(405, "不支持的请求方法", "method-not-allowed", {
                allow: Object.keys(entry.methods).sort().join(", "),
            })
        }
        if (isWriteMethod(method)) {
            const blocked = guardWrite(request, ctx.config.limits.maxBodyBytes)
            if (blocked !== null) {
                return blocked
            }
        }
        const params: string[] = []
        for (const raw of match.slice(1)) {
            const decoded = decodeSegment(raw)
            if (decoded === null) {
                return errorResponse(400, "请求路径不合法", "invalid-path")
            }
            params.push(decoded)
        }
        return await handler(ctx, request, url, params, stream)
    }
    return errorResponse(404, "接口不存在", "not-found")
}

/** 创建 HTTP handler；/api/* 与静态资源之外一律 404 */
export function createRouter(
    options: WebRouterOptions,
): (request: HttpRequest, stream: HttpStreamContext) => Promise<HttpResponse> {
    const ctx: ApiContext = {
        api: options.api,
        config: options.config,
        store: options.store,
        runtime: options.runtime,
        version: options.version,
        ...(options.hostInfo === undefined ? {} : { hostInfo: options.hostInfo }),
    }
    const staticFs = options.staticFs ?? createPluginStaticFs()
    const wwwRoot = options.wwwRoot ?? options.config.wwwDir
    return async (request: HttpRequest, stream: HttpStreamContext): Promise<HttpResponse> => {
        try {
            let url: URL
            try {
                url = new URL(request.url, "http://localhost")
            } catch {
                return applySecurityHeaders(errorResponse(400, "请求地址不合法", "invalid-url"))
            }
            if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
                return applySecurityHeaders(await routeApi(ctx, request, url, stream))
            }
            return await serveStatic(request, staticFs, {
                root: wwwRoot,
                spaFallback: ctx.config.spaFallback,
            })
        } catch (error) {
            ctx.api.logger.error(
                { error: error instanceof Error ? error.message : String(error) },
                "请求处理失败",
            )
            return applySecurityHeaders(errorResponse(500, "服务器内部错误", "internal"))
        }
    }
}
