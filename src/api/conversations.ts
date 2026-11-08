/*
 * 会话增删改查
 *
 * GET/POST /api/conversations、GET/PATCH/DELETE /api/conversations/:id、
 * POST /api/conversations/:id/active、GET /api/running
 */

import type {
    HostWorkspaceCheck,
    HostWorkspaceEntry,
    HttpRequest,
    HttpResponse,
} from "wellspring/api/host/index.ts"

import { ChatStoreError, isConversationId, type ChatCreateInput } from "../chat-store.ts"
import { CHAT_PERMISSIONS, type ChatPermission } from "../chat-types.ts"
import { errorResponse, jsonResponse, readJsonObject } from "../security.ts"
import { isPlainObject, optionalNullableText, type ApiContext } from "./context.ts"

const MAX_TITLE_INPUT = 200

function permissionOf(value: unknown): ChatPermission | null | undefined {
    if (value === undefined) {
        return undefined
    }
    return typeof value === "string" && (CHAT_PERMISSIONS as readonly string[]).includes(value)
        ? (value as ChatPermission)
        : null
}

function titleOf(value: unknown): string | null | undefined {
    if (value === undefined) {
        return undefined
    }
    if (typeof value !== "string") {
        return null
    }
    return value.trim().slice(0, MAX_TITLE_INPUT)
}

/** 会话 id 校验不通过时统一按不存在处理 */
function invalidId(): HttpResponse {
    return errorResponse(404, "会话不存在", "not-found")
}

type CwdCheck = { readonly ok: true; readonly root: string } | { readonly ok: false; readonly response: HttpResponse }

type LocationResolution =
    | { readonly response: HttpResponse }
    | { readonly cwd?: string | null; readonly workspaceId?: string | null }

/** 落库前校验工作区目录；null 表示用宿主当前目录，不校验 */
async function validateCwd(ctx: ApiContext, cwd: string): Promise<CwdCheck> {
    let check: HostWorkspaceCheck
    try {
        check = await ctx.api.agent.validateWorkspace(cwd)
    } catch {
        return { ok: false, response: errorResponse(502, "宿主调用失败", "host-error") }
    }
    if (!check.ok) {
        return {
            ok: false,
            response: errorResponse(
                400,
                `工作区不可用：${check.error ?? "未知原因"}`,
                "workspace-unavailable",
            ),
        }
    }
    return { ok: true, root: check.root }
}

/**
 * 解析会话的工作区与 cwd
 *
 * workspaceId 非空时从宿主工作区注册表取 root 作为 cwd；同时给 cwd 时以 cwd 为准
 * 显式给出的目录与解析出的目录都经 validateWorkspace 校验，宿主调用失败返回 502
 */
async function resolveLocation(
    ctx: ApiContext,
    rawCwd: string | null | undefined,
    rawWorkspaceId: string | null | undefined,
): Promise<LocationResolution> {
    let workspaceRoot: string | undefined
    if (typeof rawWorkspaceId === "string") {
        let workspaces: readonly HostWorkspaceEntry[]
        try {
            workspaces = (await ctx.api.workspaces.list()).workspaces
        } catch {
            return { response: errorResponse(502, "宿主调用失败", "host-error") }
        }
        const found = workspaces.find((item) => item.id === rawWorkspaceId)
        if (found === undefined) {
            return { response: errorResponse(400, "工作区不存在", "workspace-not-found") }
        }
        const checked = await validateCwd(ctx, found.root)
        if (!checked.ok) {
            return { response: checked.response }
        }
        workspaceRoot = checked.root
    }
    const resolved: { cwd?: string | null; workspaceId?: string | null } = {}
    if (rawWorkspaceId !== undefined) {
        resolved.workspaceId = rawWorkspaceId
    }
    if (typeof rawCwd === "string") {
        const checked = await validateCwd(ctx, rawCwd)
        if (!checked.ok) {
            return { response: checked.response }
        }
        resolved.cwd = checked.root
    } else if (rawCwd === null) {
        resolved.cwd = null
    } else if (workspaceRoot !== undefined) {
        resolved.cwd = workspaceRoot
    }
    return resolved
}

/** GET /api/conversations */
export async function handleListConversations(ctx: ApiContext): Promise<HttpResponse> {
    await ctx.store.load()
    return jsonResponse(200, { conversations: ctx.store.list(), activeId: ctx.store.activeId })
}

/** POST /api/conversations */
export async function handleCreateConversation(
    ctx: ApiContext,
    request: HttpRequest,
): Promise<HttpResponse> {
    const body = readJsonObject(request, ctx.config.limits.maxBodyBytes)
    if (body.response !== undefined || !isPlainObject(body.value)) {
        return body.response ?? errorResponse(400, "请求体不是 JSON 对象", "invalid-json")
    }
    const title = titleOf(body.value["title"])
    if (title === null) {
        return errorResponse(400, "标题不合法", "invalid-title")
    }
    const permission = permissionOf(body.value["permission"])
    if (permission === null) {
        return errorResponse(400, "权限不合法", "invalid-permission")
    }
    const cwd = optionalNullableText(body.value["cwd"])
    const workspaceId = optionalNullableText(body.value["workspaceId"])
    const provider = optionalNullableText(body.value["provider"])
    const model = optionalNullableText(body.value["model"])
    const reasoning = optionalNullableText(body.value["reasoning"])
    for (const field of [cwd, workspaceId, provider, model, reasoning]) {
        if (!field.ok) {
            return errorResponse(400, "会话字段不合法", "invalid-field")
        }
    }
    const location = await resolveLocation(ctx, cwd.value, workspaceId.value)
    if ("response" in location) {
        return location.response
    }
    const input: ChatCreateInput = {
        ...(title === undefined ? {} : { title }),
        ...(location.cwd === undefined ? {} : { cwd: location.cwd }),
        ...(location.workspaceId === undefined ? {} : { workspaceId: location.workspaceId }),
        ...(permission === undefined ? {} : { permission }),
        ...(provider.value === undefined ? {} : { provider: provider.value }),
        ...(model.value === undefined ? {} : { model: model.value }),
        ...(reasoning.value === undefined ? {} : { reasoning: reasoning.value }),
    }
    const conversation = await ctx.store.create(input)
    return jsonResponse(200, { conversation })
}

/** GET /api/conversations/:id */
export async function handleGetConversation(ctx: ApiContext, id: string): Promise<HttpResponse> {
    if (!isConversationId(id)) {
        return invalidId()
    }
    const conversation = await ctx.store.get(id)
    if (conversation === null) {
        return invalidId()
    }
    return jsonResponse(200, {
        conversation,
        running: ctx.runtime.isRunning(id),
    })
}

/** PATCH /api/conversations/:id：只更新给出的字段，返回完整会话 */
export async function handlePatchConversation(
    ctx: ApiContext,
    request: HttpRequest,
    id: string,
): Promise<HttpResponse> {
    if (!isConversationId(id)) {
        return invalidId()
    }
    const body = readJsonObject(request, ctx.config.limits.maxBodyBytes)
    if (body.response !== undefined || !isPlainObject(body.value)) {
        return body.response ?? errorResponse(400, "请求体不是 JSON 对象", "invalid-json")
    }
    const patch = body.value
    const title = titleOf(patch["title"])
    if (title === null) {
        return errorResponse(400, "标题不合法", "invalid-title")
    }
    const permission = permissionOf(patch["permission"])
    if (permission === null) {
        return errorResponse(400, "权限不合法", "invalid-permission")
    }
    const cwd = optionalNullableText(patch["cwd"])
    const workspaceId = optionalNullableText(patch["workspaceId"])
    const provider = optionalNullableText(patch["provider"])
    const model = optionalNullableText(patch["model"])
    const reasoning = optionalNullableText(patch["reasoning"])
    for (const field of [cwd, workspaceId, provider, model, reasoning]) {
        if (!field.ok) {
            return errorResponse(400, "会话字段不合法", "invalid-field")
        }
    }
    const location = await resolveLocation(ctx, cwd.value, workspaceId.value)
    if ("response" in location) {
        return location.response
    }
    try {
        const updated = await ctx.store.mutate(id, (draft) => {
            if (title !== undefined) {
                draft.title = title
            }
            if (permission !== undefined) {
                draft.permission = permission
            }
            if (location.cwd !== undefined) {
                draft.cwd = location.cwd
            }
            if (location.workspaceId !== undefined) {
                draft.workspaceId = location.workspaceId
            }
            if (provider.value !== undefined) {
                draft.provider = provider.value
            }
            if (model.value !== undefined) {
                draft.model = model.value
            }
            if (reasoning.value !== undefined) {
                draft.reasoning = reasoning.value
            }
        })
        return jsonResponse(200, { conversation: updated })
    } catch (error) {
        if (error instanceof ChatStoreError && error.code === "not-found") {
            return invalidId()
        }
        throw error
    }
}

/** DELETE /api/conversations/:id：运行中的会话先停止再删除 */
export async function handleDeleteConversation(ctx: ApiContext, id: string): Promise<HttpResponse> {
    if (!isConversationId(id)) {
        return errorResponse(400, "会话 id 不合法", "invalid-id")
    }
    if (ctx.runtime.isRunning(id)) {
        await ctx.runtime.stop(id)
    }
    await ctx.store.remove(id)
    return jsonResponse(200, { ok: true })
}

/** POST /api/conversations/:id/active */
export async function handleSetActiveConversation(
    ctx: ApiContext,
    id: string,
): Promise<HttpResponse> {
    if (!isConversationId(id)) {
        return errorResponse(400, "会话 id 不合法", "invalid-id")
    }
    const activeId = await ctx.store.setActive(id)
    return jsonResponse(200, { ok: true, activeId })
}

/** GET /api/running */
export function handleRunning(ctx: ApiContext): HttpResponse {
    return jsonResponse(200, {
        running: ctx.runtime.running().map((conversationId) => ({ conversationId })),
    })
}
