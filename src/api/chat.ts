/*
 * 对话流接口
 *
 * POST /api/conversations/:id/chat|stop|interject、GET /api/conversations/:id/resume
 * 流式 handler 立即返回 { stream: true }，写 chunk 由 chat-runtime 负责；这里加 15s 心跳
 */

import type { HttpRequest, HttpStreamContext, HttpResponse } from "wellspring/api/host/index.ts"

import { isConversationId } from "../chat-store.ts"
import { CHAT_PERMISSIONS, type ChatPermission, type ChatRequest } from "../chat-types.ts"
import {
    errorResponse,
    jsonResponse,
    readJsonObject,
    SSE_PING_CHUNK,
    SSE_PING_MS,
    sseResponse,
} from "../security.ts"
import { isPlainObject, type ApiContext } from "./context.ts"

const MAX_REFERENCE_CHARS = 512

interface ChatBodyResult {
    readonly ok: boolean
    readonly request?: ChatRequest
    readonly response?: HttpResponse
}

/** 聊天请求体校验；缺省字段由 chat-runtime 用会话设置补 */
function parseChatBody(body: unknown, ctx: ApiContext): ChatBodyResult {
    if (!isPlainObject(body)) {
        return { ok: false, response: errorResponse(400, "请求体不是 JSON 对象", "invalid-json") }
    }
    const maxChars = ctx.config.limits.maxMessageChars
    const rawMessage = body["message"]
    if (typeof rawMessage !== "string") {
        return { ok: false, response: errorResponse(400, "消息不能为空", "invalid-message") }
    }
    const message = rawMessage.trim()
    if (message === "") {
        return { ok: false, response: errorResponse(400, "消息不能为空", "invalid-message") }
    }
    if (message.length > maxChars) {
        return {
            ok: false,
            response: errorResponse(413, `消息超过 ${maxChars} 字符`, "message-too-long"),
        }
    }
    let references: readonly string[] | undefined
    const rawReferences = body["references"]
    if (rawReferences !== undefined && rawReferences !== null) {
        if (!Array.isArray(rawReferences)) {
            return { ok: false, response: errorResponse(400, "引用列表不合法", "invalid-references") }
        }
        if (rawReferences.length > ctx.config.limits.maxReferences) {
            return {
                ok: false,
                response: errorResponse(
                    400,
                    `引用文件超过 ${ctx.config.limits.maxReferences} 个`,
                    "too-many-references",
                ),
            }
        }
        const list: string[] = []
        for (const item of rawReferences) {
            if (typeof item !== "string") {
                return { ok: false, response: errorResponse(400, "引用列表不合法", "invalid-references") }
            }
            const value = item.trim()
            if (value === "" || value.length > MAX_REFERENCE_CHARS) {
                return {
                    ok: false,
                    response: errorResponse(
                        400,
                        `引用路径超过 ${MAX_REFERENCE_CHARS} 字符`,
                        "invalid-reference",
                    ),
                }
            }
            list.push(value)
        }
        references = list
    }
    let permission: ChatPermission | undefined
    const rawPermission = body["permission"]
    if (rawPermission !== undefined && rawPermission !== null) {
        if (
            typeof rawPermission !== "string" ||
            !(CHAT_PERMISSIONS as readonly string[]).includes(rawPermission)
        ) {
            return { ok: false, response: errorResponse(400, "权限不合法", "invalid-permission") }
        }
        permission = rawPermission as ChatPermission
    }
    const overrides: { provider?: string; model?: string; reasoning?: string } = {}
    for (const key of ["provider", "model", "reasoning"] as const) {
        const raw = body[key]
        if (raw === undefined || raw === null) {
            continue
        }
        if (typeof raw !== "string") {
            return { ok: false, response: errorResponse(400, "模型设置不合法", "invalid-model-setting") }
        }
        const value = raw.trim()
        if (value !== "") {
            overrides[key] = value
        }
    }
    return {
        ok: true,
        request: {
            message,
            ...(references === undefined ? {} : { references }),
            ...(permission === undefined ? {} : { permission }),
            ...overrides,
        },
    }
}

interface TurnStream {
    readonly stream: HttpStreamContext
    readonly dispose: () => void
}

/** 包装 SSE 流：15s 心跳，end 时清定时器；写失败静默（客户端已断开） */
function wrapTurnStream(raw: HttpStreamContext): TurnStream {
    let ended = false
    const ping = setInterval(() => {
        if (ended) {
            return
        }
        try {
            raw.write(SSE_PING_CHUNK)
        } catch {
            /* 客户端已断开 */
        }
    }, SSE_PING_MS)
    const stream: HttpStreamContext = {
        write(chunk: string): void {
            if (ended) {
                return
            }
            try {
                raw.write(chunk)
            } catch {
                /* 客户端已断开 */
            }
        },
        end(): void {
            if (ended) {
                return
            }
            ended = true
            clearInterval(ping)
            try {
                raw.end()
            } catch {
                /* 已结束 */
            }
        },
    }
    return {
        stream,
        dispose: () => {
            ended = true
            clearInterval(ping)
        },
    }
}

/** POST /api/conversations/:id/chat */
export async function handleChat(
    ctx: ApiContext,
    request: HttpRequest,
    id: string,
    rawStream: HttpStreamContext,
): Promise<HttpResponse> {
    if (!isConversationId(id)) {
        return errorResponse(404, "会话不存在", "not-found")
    }
    const body = readJsonObject(request, ctx.config.limits.maxBodyBytes)
    if (body.response !== undefined) {
        return body.response
    }
    const parsed = parseChatBody(body.value, ctx)
    if (!parsed.ok || parsed.request === undefined) {
        return parsed.response ?? errorResponse(400, "请求体不合法", "invalid-request")
    }
    const conversation = await ctx.store.get(id)
    if (conversation === null) {
        return errorResponse(404, "会话不存在", "not-found")
    }
    if (ctx.runtime.isRunning(id)) {
        return errorResponse(409, "会话正在运行中", "busy")
    }
    const turn = wrapTurnStream(rawStream)
    try {
        /* runtime 在终态调用 end；这里不等整轮 */
        await ctx.runtime.startTurn(id, parsed.request, turn.stream)
    } catch (error) {
        turn.dispose()
        throw error
    }
    return sseResponse()
}

/** GET /api/conversations/:id/resume */
export async function handleResume(
    ctx: ApiContext,
    url: URL,
    id: string,
    rawStream: HttpStreamContext,
): Promise<HttpResponse> {
    const noTurn = jsonResponse(200, { ok: false, active: false, error: "没有可续接的回复" })
    /* peek 只探进度：无轮次也返回完整形状，前端按 done=true 处理 */
    if (url.searchParams.get("peek") === "1") {
        const info = isConversationId(id) ? ctx.runtime.peek(id) : null
        return jsonResponse(
            200,
            info === null
                ? { ok: true, active: false, total: 0, done: true, truncated: false }
                : {
                      ok: true,
                      active: info.active,
                      total: info.total,
                      done: info.done,
                      truncated: info.truncated,
                  },
        )
    }
    if (!isConversationId(id)) {
        return noTurn
    }
    const info = ctx.runtime.peek(id)
    if (info === null) {
        return noTurn
    }
    if (info.truncated) {
        return jsonResponse(200, {
            ok: false,
            active: false,
            error: "本轮回复事件过多，无法续接",
        })
    }
    /* 已收尾的轮次不再建流，前端按无轮次处理 */
    if (!info.active) {
        return noTurn
    }
    const rawSince = Number(url.searchParams.get("since") ?? "0")
    const since = Number.isInteger(rawSince) && rawSince >= 0 ? rawSince : 0
    const turn = wrapTurnStream(rawStream)
    try {
        await ctx.runtime.resume(id, since, turn.stream)
    } catch (error) {
        turn.dispose()
        throw error
    }
    return sseResponse()
}

/** POST /api/conversations/:id/stop：幂等 */
export async function handleStop(ctx: ApiContext, id: string): Promise<HttpResponse> {
    if (!isConversationId(id)) {
        return errorResponse(400, "会话 id 不合法", "invalid-id")
    }
    const stopped = await ctx.runtime.stop(id)
    return jsonResponse(200, { ok: true, stopped })
}

/** POST /api/conversations/:id/interject */
export async function handleInterject(
    ctx: ApiContext,
    request: HttpRequest,
    id: string,
): Promise<HttpResponse> {
    if (!isConversationId(id)) {
        return errorResponse(404, "会话不存在", "not-found")
    }
    const body = readJsonObject(request, ctx.config.limits.maxBodyBytes)
    if (body.response !== undefined || !isPlainObject(body.value)) {
        return body.response ?? errorResponse(400, "请求体不是 JSON 对象", "invalid-json")
    }
    const rawMessage = body.value["message"]
    const message = typeof rawMessage === "string" ? rawMessage.trim() : ""
    if (message === "") {
        return errorResponse(400, "消息不能为空", "invalid-message")
    }
    const maxChars = ctx.config.limits.maxMessageChars
    if (message.length > maxChars) {
        return errorResponse(413, `消息超过 ${maxChars} 字符`, "message-too-long")
    }
    const conversation = await ctx.store.get(id)
    if (conversation === null) {
        return errorResponse(404, "会话不存在", "not-found")
    }
    const accepted = await ctx.runtime.interject(id, message)
    if (!accepted) {
        return errorResponse(409, "这一轮已经结束", "not-running")
    }
    return jsonResponse(200, { ok: true, accepted: true })
}
