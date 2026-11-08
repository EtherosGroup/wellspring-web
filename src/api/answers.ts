/*
 * 提问与提权审批应答
 *
 * POST /api/asks/:askId、POST /api/approvals/:approvalId
 * accepted=false 表示已过期或不存在（stale），仍返回 200
 */

import type { HttpRequest, HttpResponse } from "wellspring/api/host/index.ts"

import { errorResponse, jsonResponse, readJsonObject } from "../security.ts"
import { decodeSegment, isPlainObject, type ApiContext } from "./context.ts"

const MAX_ANSWER_CHARS = 8_000

function idOf(raw: string): string | null {
    const id = decodeSegment(raw)
    if (id === null || id.length > 200) {
        return null
    }
    return id
}

/** POST /api/asks/:askId */
export async function handleAskAnswer(
    ctx: ApiContext,
    request: HttpRequest,
    rawAskId: string,
): Promise<HttpResponse> {
    const askId = idOf(rawAskId)
    if (askId === null) {
        return errorResponse(400, "提问 id 不合法", "invalid-ask")
    }
    const body = readJsonObject(request, ctx.config.limits.maxBodyBytes)
    if (body.response !== undefined || !isPlainObject(body.value)) {
        return body.response ?? errorResponse(400, "请求体不是 JSON 对象", "invalid-json")
    }
    const rawAnswer = body.value["answer"]
    if (typeof rawAnswer !== "string") {
        return errorResponse(400, "缺少 answer", "invalid-answer")
    }
    const answer = rawAnswer.slice(0, MAX_ANSWER_CHARS)
    const accepted = await ctx.runtime.respondAsk(askId, answer)
    return jsonResponse(200, { ok: true, accepted, stale: !accepted })
}

/** POST /api/approvals/:approvalId */
export async function handleApprovalAnswer(
    ctx: ApiContext,
    request: HttpRequest,
    rawApprovalId: string,
): Promise<HttpResponse> {
    const approvalId = idOf(rawApprovalId)
    if (approvalId === null) {
        return errorResponse(400, "审批 id 不合法", "invalid-approval")
    }
    const body = readJsonObject(request, ctx.config.limits.maxBodyBytes)
    if (body.response !== undefined || !isPlainObject(body.value)) {
        return body.response ?? errorResponse(400, "请求体不是 JSON 对象", "invalid-json")
    }
    const approved = body.value["approved"]
    if (typeof approved !== "boolean") {
        return errorResponse(400, "approved 不是布尔值", "invalid-approved")
    }
    const accepted = await ctx.runtime.respondApproval(approvalId, approved)
    return jsonResponse(200, { ok: true, accepted, stale: !accepted })
}
