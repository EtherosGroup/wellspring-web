/*
 * API handler 的共享上下文与辅助函数
 */

import type { HttpResponse, PluginApi } from "wellspring/api/host/index.ts"

import type { ChatStore } from "../chat-store.ts"
import type { ChatRuntime } from "../chat-runtime.ts"
import type { ConversationSummary, StoredConversation } from "../chat-types.ts"
import type { WebConfig } from "../config.ts"
import { errorResponse } from "../security.ts"

/** HTTP 层用到的会话存储接口；ChatStore 结构兼容，测试可注入假实现 */
export type ChatStoreLike = Pick<
    ChatStore,
    "load" | "activeId" | "list" | "get" | "create" | "mutate" | "remove" | "setActive"
>

/** HTTP 层用到的运行态接口；ChatRuntime 结构兼容，测试可注入假实现 */
export type ChatRuntimeLike = Pick<
    ChatRuntime,
    "running" | "isRunning" | "startTurn" | "resume" | "peek" | "stop" | "interject" | "respondAsk" | "respondApproval"
>

export interface HostInfoPayload {
    readonly status: string
    readonly platform: string
    readonly arch: string
    readonly node: string
    readonly cwd: string
}

export interface ApiContext {
    readonly api: PluginApi
    readonly config: WebConfig
    readonly store: ChatStoreLike
    readonly runtime: ChatRuntimeLike
    readonly version: string
    /** 宿主信息探测；缺省用宿主 SDK getHost，测试可注入 */
    readonly hostInfo?: () => HostInfoPayload | null | Promise<HostInfoPayload | null>
}

/** 完整会话 → 列表摘要（去掉 messages / v） */
export function summaryOf(conversation: StoredConversation): ConversationSummary {
    const { v: _v, messages: _messages, ...summary } = conversation
    return summary
}

/** URL 路径段解码；非法编码返回 null */
export function decodeSegment(raw: string): string | null {
    try {
        const decoded = decodeURIComponent(raw)
        return decoded === "" ? null : decoded
    } catch {
        return null
    }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 可空文本字段：undefined 表示未提供，null/空白表示清空 */
export function optionalNullableText(value: unknown): { readonly ok: boolean; readonly value?: string | null } {
    if (value === undefined) {
        return { ok: true }
    }
    if (value === null) {
        return { ok: true, value: null }
    }
    if (typeof value !== "string") {
        return { ok: false }
    }
    const trimmed = value.trim()
    return { ok: true, value: trimmed === "" ? null : trimmed }
}

/** 宿主能力缺失时的错误 */
export function hostCapabilityError(error: unknown): HttpResponse {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("hostApi")) {
        return errorResponse(501, "宿主缺少对应能力", "capability-missing")
    }
    return errorResponse(502, "宿主调用失败", "host-error")
}

/** 宿主错误 → 中文短句 */
export function hostErrorText(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    const known: Readonly<Record<string, string>> = {
        "models.provider-not-found": "供应商不存在",
        "models.invalid-model": "模型名不合法",
        "models.invalid-reasoning": "推理强度不合法",
        "workspace.not-found": "工作区不存在",
        "workspace.invalid": "工作区不可用",
    }
    return known[message] ?? message
}
