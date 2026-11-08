/*
 * 流事件 → 助手消息过程块
 *
 * 纯函数，不改外部状态；store 可直接调用，也作为事件应用的参考实现
 * 块顺序即事件发生顺序；正文合并相邻 text 块，思考块在首个正文/工具到达时截止
 */

import type {
    ApprovalBlock,
    AskBlock,
    Block,
    ChatEvent,
    ChatMessage,
    MessageStatus,
    ReasoningBlock,
    SteerBlock,
    ToolBlock,
} from "../types"
import { formatDuration } from "./format"

export interface EventApplyResult {
    /** 事件是否作用于该助手消息 */
    handled: boolean
    /** step 事件的步号，其它事件为 null */
    step: number | null
}

/* ------------------------------ 消息构造 ------------------------------ */

export function createAssistantMessage(id: string, at = Date.now()): ChatMessage {
    return {
        id,
        role: "assistant",
        at,
        text: "",
        blocks: [],
        status: "streaming",
        startedAt: at,
        steps: 0,
    }
}

export function createUserMessage(id: string, at: number, text: string): ChatMessage {
    return { id, role: "user", at, text, blocks: [], status: "done" }
}

/* ------------------------------ 块查找 ------------------------------ */

function lastBlock(message: ChatMessage): Block | undefined {
    return message.blocks.length > 0 ? message.blocks[message.blocks.length - 1] : undefined
}

function findTool(message: ChatMessage, id: string): ToolBlock | undefined {
    for (let index = message.blocks.length - 1; index >= 0; index -= 1) {
        const block = message.blocks[index]
        if (block !== undefined && block.type === "tool" && block.id === id) {
            return block
        }
    }
    return undefined
}

function findAsk(message: ChatMessage, askId: string): AskBlock | undefined {
    for (let index = message.blocks.length - 1; index >= 0; index -= 1) {
        const block = message.blocks[index]
        if (block !== undefined && block.type === "ask" && block.askId === askId) {
            return block
        }
    }
    return undefined
}

function findApproval(message: ChatMessage, approvalId: string): ApprovalBlock | undefined {
    for (let index = message.blocks.length - 1; index >= 0; index -= 1) {
        const block = message.blocks[index]
        if (block !== undefined && block.type === "approval" && block.approvalId === approvalId) {
            return block
        }
    }
    return undefined
}

/* ------------------------------ 块写入 ------------------------------ */

function closeReasoning(message: ChatMessage, at: number): void {
    const block = lastBlock(message)
    if (block !== undefined && block.type === "reasoning" && block.endedAt === null) {
        block.endedAt = at
    }
}

function appendText(message: ChatMessage, text: string, at: number): void {
    if (text === "") {
        return
    }
    closeReasoning(message, at)
    const block = lastBlock(message)
    if (block !== undefined && block.type === "text") {
        block.text += text
        return
    }
    message.blocks.push({ type: "text", text })
}

function appendReasoning(message: ChatMessage, text: string, at: number): void {
    if (text === "") {
        return
    }
    const block = lastBlock(message)
    if (block !== undefined && block.type === "reasoning" && block.endedAt === null) {
        block.text += text
        return
    }
    message.blocks.push({ type: "reasoning", text, startedAt: at, endedAt: null })
}

function applyToolEvent(message: ChatMessage, event: Extract<ChatEvent, { type: "tool" }>, at: number): void {
    closeReasoning(message, at)
    const existing = findTool(message, event.id)
    if (existing !== undefined) {
        existing.name = event.name
        existing.phase = event.phase
        if (event.arguments !== undefined) {
            existing.arguments = event.arguments
        }
        if (event.ok !== undefined) {
            existing.ok = event.ok
        }
        if (event.result !== undefined) {
            existing.result = event.result
        }
        if (event.truncated !== undefined) {
            existing.truncated = event.truncated
        }
        if (event.phase === "end") {
            existing.endedAt = at
            existing.status = event.ok === false ? "error" : "ok"
        }
        return
    }
    message.blocks.push({
        type: "tool",
        id: event.id,
        name: event.name,
        phase: event.phase,
        arguments: event.arguments,
        ok: event.ok,
        result: event.result,
        truncated: event.truncated,
        startedAt: at,
        endedAt: event.phase === "end" ? at : null,
        status: event.phase === "end" ? (event.ok === false ? "error" : "ok") : "running",
    })
}

function applyAskEvent(message: ChatMessage, event: Extract<ChatEvent, { type: "ask" }>, at: number): void {
    const existing = findAsk(message, event.askId)
    /* 已答/已失效的重放不重建卡片 */
    if (event.request === null) {
        return
    }
    if (existing !== undefined) {
        if (existing.answer === null) {
            existing.question = event.request.question
            existing.options = event.request.options ?? []
        }
        return
    }
    message.blocks.push({
        type: "ask",
        askId: event.askId,
        question: event.request.question,
        options: event.request.options ?? [],
        answer: null,
        at,
    })
}

function applyApprovalEvent(
    message: ChatMessage,
    event: Extract<ChatEvent, { type: "approval" }>,
    at: number,
): void {
    const existing = findApproval(message, event.approvalId)
    if (event.request === null) {
        return
    }
    const request = event.request
    if (existing !== undefined) {
        if (existing.approved === null) {
            existing.command = request.command
            existing.argv = request.argv
            existing.cwd = request.cwd
            existing.justification = request.justification
        }
        return
    }
    message.blocks.push({
        type: "approval",
        approvalId: event.approvalId,
        command: request.command,
        argv: request.argv,
        cwd: request.cwd,
        currentPermission: request.currentPermission,
        requestedPermission: request.requestedPermission,
        justification: request.justification,
        network: request.network,
        background: request.background,
        stdin: request.stdin,
        timeoutMs: request.timeoutMs,
        approved: null,
        at,
    })
}

function applySteerEvent(message: ChatMessage, event: Extract<ChatEvent, { type: "steer" }>, at: number): void {
    closeReasoning(message, at)
    const block: SteerBlock = {
        type: "steer",
        text: event.text,
        at: Number.isFinite(event.at) && event.at > 0 ? event.at : at,
    }
    message.blocks.push(block)
}

function applySandboxEvent(
    message: ChatMessage,
    event: Extract<ChatEvent, { type: "sandbox-prepare" }>,
    at: number,
): void {
    if (event.phase === "started") {
        message.blocks.push({ type: "note", text: "准备沙盒工作区", at, tone: "info" })
        return
    }
    if (event.phase === "completed") {
        const elapsed = typeof event.elapsedMs === "number" ? `（${formatDuration(event.elapsedMs)}）` : ""
        message.blocks.push({ type: "note", text: `沙盒就绪${elapsed}`, at, tone: "info" })
        return
    }
    message.blocks.push({
        type: "note",
        text: `沙盒准备失败：${event.error ?? "未知原因"}`,
        at,
        tone: "warn",
    })
}

/** 终止开放块并同步正文 */
function settleMessage(message: ChatMessage, status: MessageStatus, at: number): void {
    closeReasoning(message, at)
    for (const block of message.blocks) {
        if (block.type === "tool" && block.status === "running") {
            block.endedAt = block.endedAt ?? at
        }
    }
    if (message.status === "streaming") {
        message.status = status
    }
    message.endedAt = message.endedAt ?? at
    if (message.text === "") {
        message.text = collectMessageText(message)
    }
}

/* ------------------------------ 正文汇总 ------------------------------ */

/** 正文块按顺序拼接，用于收尾写入 message.text */
export function collectMessageText(message: ChatMessage): string {
    const parts: string[] = []
    for (const block of message.blocks) {
        if (block.type === "text" && block.text.trim() !== "") {
            parts.push(block.text)
        }
    }
    return parts.join("\n\n")
}

/* ------------------------------ 事件入口 ------------------------------ */

function handled(step: number | null = null): EventApplyResult {
    return { handled: true, step }
}

function ignored(): EventApplyResult {
    return { handled: false, step: null }
}

/**
 * 把一个流事件应用到助手消息
 *
 * accepted / session / resume 不由消息承载，返回 handled=false，由 store 处理
 * step 更新 message.turn / message.steps，并在返回值里给出步号
 */
export function addEventToMessage(
    message: ChatMessage,
    event: ChatEvent,
    now = Date.now(),
): EventApplyResult {
    switch (event.type) {
        case "delta": {
            appendText(message, event.text, now)
            return handled()
        }
        case "reasoning": {
            appendReasoning(message, event.text, now)
            return handled()
        }
        case "tool": {
            applyToolEvent(message, event, now)
            return handled()
        }
        case "ask": {
            applyAskEvent(message, event, now)
            return handled()
        }
        case "approval": {
            applyApprovalEvent(message, event, now)
            return handled()
        }
        case "steer": {
            applySteerEvent(message, event, now)
            return handled()
        }
        case "sandbox-prepare": {
            applySandboxEvent(message, event, now)
            return handled()
        }
        case "step": {
            message.turn = event.turn
            message.steps = Math.max(message.steps ?? 0, event.step)
            return handled(event.step)
        }
        case "stopped": {
            settleMessage(message, "stopped", now)
            return handled()
        }
        case "error": {
            message.error = event.error
            settleMessage(message, "error", now)
            return handled()
        }
        case "done": {
            settleMessage(message, "done", now)
            const hasText = message.blocks.some((block) => block.type === "text" && block.text.trim() !== "")
            if (!hasText && event.reply.trim() !== "") {
                message.blocks.push({ type: "text", text: event.reply })
            }
            message.text = collectMessageText(message)
            message.model = event.model
            if (event.usage !== null) {
                message.usage = event.usage
            }
            message.turn = event.turn
            message.steps = event.steps
            return handled()
        }
        case "truncated": {
            message.blocks.push({
                type: "note",
                text: "事件缓冲已截断，刷新后无法完整续接本轮",
                at: now,
                tone: "warn",
            })
            return handled()
        }
        case "replaced": {
            message.error = "会话已开始新一轮"
            settleMessage(message, "interrupted", now)
            return handled()
        }
        case "accepted":
        case "session":
        case "resume": {
            /* 会话级事件 */
            return ignored()
        }
        default: {
            return ignored()
        }
    }
}

/* ------------------------------ 应答写回 ------------------------------ */

/** 回答提问后写回块，未找到返回 false */
export function markAskAnswered(message: ChatMessage, askId: string, answer: string): boolean {
    const block = findAsk(message, askId)
    if (block === undefined) {
        return false
    }
    block.answer = answer
    return true
}

/** 审批后写回块，未找到返回 false */
export function markApprovalAnswered(message: ChatMessage, approvalId: string, approved: boolean): boolean {
    const block = findApproval(message, approvalId)
    if (block === undefined) {
        return false
    }
    block.approved = approved
    return true
}

/** 兜底收尾：无终态事件时按指定状态结束消息 */
export function closeMessage(message: ChatMessage, status: MessageStatus = "interrupted", at = Date.now()): void {
    settleMessage(message, status, at)
}

/* ------------------------------ 过程块摘要 ------------------------------ */

/** 思考块用时（毫秒），流式中按当前时间估算 */
export function reasoningElapsed(block: ReasoningBlock, now = Date.now()): number {
    const end = block.endedAt ?? now
    return Math.max(0, end - block.startedAt)
}

/** 工具块用时（毫秒），流式中按当前时间估算 */
export function toolElapsed(block: ToolBlock, now = Date.now()): number {
    const end = block.endedAt ?? now
    return Math.max(0, end - block.startedAt)
}
