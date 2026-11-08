/*
 * 状态与模型接口
 *
 * GET /api/bootstrap、GET /api/models、POST /api/models/active
 */

import type { HostModelsState, HttpRequest, HttpResponse } from "wellspring/api/host/index.ts"

import type { ChatLimits } from "../chat-types.ts"
import { errorResponse, jsonResponse, readJsonObject } from "../security.ts"
import {
    hostErrorText,
    isPlainObject,
    type ApiContext,
    type HostInfoPayload,
} from "./context.ts"

interface HostModule {
    getHost(): {
        getOS(): { platform: string; arch: string; node: string; cwd: string }
        getStatus(): string
    }
}

let hostModulePromise: Promise<HostModule> | null = null

/**
 * 宿主 SDK 延迟加载
 *
 * 沙箱内由宿主 alias 解析 bare specifier；单测环境没有该包，失败时 host 返回 null
 */
function hostModule(): Promise<HostModule> {
    hostModulePromise ??= import("wellspring/api/host/index.ts") as Promise<HostModule>
    return hostModulePromise
}

/** 宿主信息；getHost 不可用时返回 null */
async function hostSnapshot(): Promise<HostInfoPayload | null> {
    try {
        const host = (await hostModule()).getHost()
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
}

async function modelsState(ctx: ApiContext): Promise<HostModelsState | null> {
    try {
        return await ctx.api.models.state()
    } catch (error) {
        ctx.api.logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            "读取模型状态失败",
        )
        return null
    }
}

async function workspacesList(ctx: ApiContext): Promise<readonly unknown[]> {
    try {
        return (await ctx.api.workspaces.list()).workspaces
    } catch (error) {
        ctx.api.logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            "读取工作区失败",
        )
        return []
    }
}

/** GET /api/bootstrap */
export async function handleBootstrap(ctx: ApiContext, request: HttpRequest): Promise<HttpResponse> {
    await ctx.store.load()
    const limits: ChatLimits = ctx.config.limits
    return jsonResponse(200, {
        version: ctx.version,
        user: request.headers["x-wellspring-user"]?.trim() || null,
        host: await (ctx.hostInfo === undefined ? hostSnapshot() : ctx.hostInfo()),
        models: await modelsState(ctx),
        workspaces: await workspacesList(ctx),
        conversations: ctx.store.list(),
        activeId: ctx.store.activeId,
        running: ctx.runtime.running(),
        limits,
    })
}

/** GET /api/models */
export async function handleModels(ctx: ApiContext): Promise<HttpResponse> {
    return jsonResponse(200, { models: await modelsState(ctx) })
}

/** POST /api/models/active：写宿主全局默认，新会话沿用 */
export async function handleSetActiveModel(
    ctx: ApiContext,
    request: HttpRequest,
): Promise<HttpResponse> {
    const body = readJsonObject(request, ctx.config.limits.maxBodyBytes)
    if (body.response !== undefined || !isPlainObject(body.value)) {
        return body.response ?? errorResponse(400, "请求体不是 JSON 对象", "invalid-json")
    }
    const providerId = typeof body.value["providerId"] === "string" ? body.value["providerId"].trim() : ""
    if (providerId === "") {
        return errorResponse(400, "缺少 providerId", "invalid-provider")
    }
    const rawModel = body.value["model"]
    if (rawModel !== undefined && rawModel !== null && typeof rawModel !== "string") {
        return errorResponse(400, "模型名不合法", "invalid-model")
    }
    const rawReasoning = body.value["reasoning"]
    if (rawReasoning !== undefined && rawReasoning !== null && typeof rawReasoning !== "string") {
        return errorResponse(400, "推理强度不合法", "invalid-reasoning")
    }
    const model = typeof rawModel === "string" && rawModel.trim() !== "" ? rawModel.trim() : null
    const reasoning =
        typeof rawReasoning === "string" && rawReasoning.trim() !== "" ? rawReasoning.trim() : null
    try {
        const models = await ctx.api.models.setActive(providerId, model, reasoning)
        return jsonResponse(200, { models })
    } catch (error) {
        return errorResponse(400, hostErrorText(error), "models-invalid")
    }
}
