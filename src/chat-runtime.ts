/*
 * 每会话单活跃轮次的运行态
 *
 * agent.stream 事件 → SSE chunk 缓冲（raw chunk 数组）+ 订阅者实时推送
 * 缓冲用于刷新/断线续接：resume 先写 resume 标记，再 slice(since) 重放
 * 宿主 stream() 的 Promise resolve = 正常完成，reject = 失败；停止时也 resolve
 *
 * 事件缓冲上限 turnBufferChars，超限发 truncated 后丢弃缓冲，实时推送继续
 * 终态轮次保留 5 分钟（最多 8 轮）供 peek/resume
 */

import type {
    HostAgentApi,
    HostAgentChatInput,
    HostAgentChatResult,
    HostAgentStreamEvent,
    HttpStreamContext,
    SandboxPrepareEvent as HostSandboxPrepareEvent,
} from "wellspring/api/host/index.ts"

import type {
    ApprovalBlock,
    ApprovalRequestPayload,
    AskBlock,
    AskRequestPayload,
    Block,
    ChatLimits,
    ChatPermission,
    ChatRequest,
    ChatStreamEvent,
    MessageStatus,
    SandboxPrepareEvent,
    StoredMessage,
    ToolBlock,
    Usage,
} from "./chat-types.ts"
import type { ChatLogger, ConversationDraft } from "./chat-store.ts"
import { ChatStore, ChatStoreError, isConversationId, resolveChatLimits } from "./chat-store.ts"

/** 运行态用到的宿主 agent API 子集 */
export type ChatAgentApi = Pick<
    HostAgentApi,
    "stream" | "stop" | "interject" | "respondAsk" | "respondApproval"
>

export interface ChatRuntimeOptions {
    readonly agent: ChatAgentApi
    readonly store: ChatStore
    readonly limits?: Partial<ChatLimits>
    readonly logger?: ChatLogger
}

export interface ChatTurnInfo {
    readonly active: boolean
    readonly done: boolean
    readonly total: number
    readonly truncated: boolean
}

export type ChatRuntimeErrorCode = "busy" | "not-found" | "invalid"

export class ChatRuntimeError extends Error {
    readonly code: ChatRuntimeErrorCode

    constructor(code: ChatRuntimeErrorCode, message: string) {
        super(message)
        this.name = "ChatRuntimeError"
        this.code = code
    }
}

export interface ChatErrorMapping {
    readonly error: string
    readonly code: string
}

/** 流式期间增量落盘间隔 */
const PERSIST_INTERVAL_MS = 1000
/** 终态轮次缓冲保留时长 */
const TURN_RETENTION_MS = 5 * 60 * 1000
/** 终态轮次缓冲最多保留个数 */
const MAX_RETAINED_TURNS = 8
/** 提问答案长度上限（宿主同值） */
const MAX_ANSWER_CHARS = 8000

interface RequestRecord {
    readonly turn: TurnState
    readonly kind: "ask" | "approval"
    /** 缓冲中的 chunk 下标；-1 表示缓冲已丢弃 */
    readonly index: number
}

interface TurnState {
    readonly conversationId: string
    readonly startedAt: number
    readonly userMessageId: string
    readonly assistantMessageId: string
    sessionId: string | null
    events: string[] | null
    chars: number
    truncated: boolean
    done: boolean
    stopped: boolean
    replaced: boolean
    finalized: boolean
    endedAt: number | null
    reply: string
    text: string
    blocks: Block[]
    turnNumber: number
    steps: number
    model: string | null
    usage: Usage | null
    error: string | null
    finalStatus: MessageStatus | null
    readonly listeners: Set<HttpStreamContext>
    persistTimer: ReturnType<typeof setTimeout> | null
    retentionTimer: ReturnType<typeof setTimeout> | null
    stopRequested: boolean
    stopPending: boolean
}

type TurnOutcome = "done" | "stopped" | "error" | "interrupted"

export class ChatRuntime {
    readonly #agent: ChatAgentApi
    readonly #store: ChatStore
    readonly #limits: ChatLimits
    readonly #logger: ChatLogger

    readonly #turns = new Map<string, TurnState>()
    readonly #requests = new Map<string, RequestRecord>()
    readonly #starting = new Set<string>()

    constructor(options: ChatRuntimeOptions) {
        this.#agent = options.agent
        this.#store = options.store
        this.#limits = resolveChatLimits(options.limits)
        this.#logger = options.logger ?? {}
    }

    running(): string[] {
        const ids: string[] = []
        for (const turn of this.#turns.values()) {
            if (!turn.done) {
                ids.push(turn.conversationId)
            }
        }
        return ids
    }

    isRunning(conversationId: string): boolean {
        return this.#turns.get(conversationId)?.done === false
    }

    /**
     * 开始一轮：先落库 user/assistant 消息，再写 accepted，然后后台跑宿主流
     *
     * 不向调用方抛错：预检失败时写 error 事件并 end，SSE 不会挂住
     */
    async startTurn(
        conversationId: string,
        request: ChatRequest,
        stream: HttpStreamContext,
    ): Promise<void> {
        try {
            await this.#beginTurn(conversationId, request, stream)
        } catch (error) {
            const mapping = runtimeErrorMapping(error)
            this.#logger.warn?.({ conversationId, error: String(error) }, "开始轮次失败")
            this.#write(stream, serializeEvent({ type: "error", error: mapping.error, code: mapping.code }))
            this.#end(stream)
        }
    }

    /** 保留轮次信息；无轮次返回 null */
    peek(conversationId: string): ChatTurnInfo | null {
        const turn = this.#turns.get(conversationId)
        if (turn === undefined) {
            return null
        }
        return {
            active: !turn.done,
            done: turn.done,
            total: turn.events?.length ?? 0,
            truncated: turn.truncated,
        }
    }

    /**
     * 续接：写 resume 标记（不占缓冲下标），重放 slice(since)，未结束则注册实时订阅
     *
     * 调用前先用 peek 判断能否续接；写失败时直接结束流
     */
    async resume(conversationId: string, since: number, stream: HttpStreamContext): Promise<void> {
        const turn = this.#turns.get(conversationId)
        if (turn === undefined) {
            this.#write(stream, serializeEvent({ type: "error", error: "没有可续接的回复", code: "no-turn" }))
            this.#end(stream)
            return
        }
        if (turn.truncated) {
            this.#write(
                stream,
                serializeEvent({ type: "error", error: "本轮回复事件过多，无法续接", code: "truncated" }),
            )
            this.#end(stream)
            return
        }
        const events = turn.events ?? []
        const total = events.length
        const from = Number.isInteger(since) && since >= 0 && since <= total ? since : 0
        if (!this.#write(stream, serializeEvent({ type: "resume", active: !turn.done, from, total }))) {
            return
        }
        for (let index = from; index < events.length; index += 1) {
            const chunk = events[index]
            if (chunk === undefined) {
                continue
            }
            if (!this.#write(stream, chunk)) {
                return
            }
        }
        if (turn.done) {
            this.#end(stream)
            return
        }
        turn.listeners.add(stream)
    }

    /**
     * 停止当前轮次：立即发 stopped 并关闭订阅，等宿主 stream resolve 后收尾
     *
     * 幂等；无进行中轮次返回 false
     */
    async stop(conversationId: string): Promise<boolean> {
        const turn = this.#turns.get(conversationId)
        if (turn === undefined || turn.done) {
            return false
        }
        turn.stopped = true
        turn.done = true
        turn.endedAt = Date.now()
        this.#clearPersistTimer(turn)
        this.#settleBlocks(turn, turn.endedAt)
        turn.text = textOfBlocks(turn.blocks)
        this.#appendEvent(turn, { type: "stopped", at: turn.endedAt })
        this.#endListeners(turn)
        this.#clearRequests(turn)
        turn.finalStatus = "stopped"
        await this.#stopHost(turn)
        // 先落盘再返回，刷新后的会话状态与流里的 stopped 一致
        await this.#persistTurn(turn)
        this.#scheduleRetention(turn)
        return true
    }

    /**
     * 注入沙盒工作区准备事件：index.ts 订阅 SANDBOX_PREPARE_EVENT 后按 sessionId 路由
     *
     * 返回投递的活跃轮次数量；事件不入会话记录，只进流缓冲
     */
    injectSandboxPrepare(event: HostSandboxPrepareEvent): number {
        const eventSessionId = typeof event.sessionId === "string" ? event.sessionId : null
        let delivered = 0
        for (const turn of this.#turns.values()) {
            if (turn.done || turn.replaced) {
                continue
            }
            if (eventSessionId !== null && turn.sessionId !== null && turn.sessionId !== eventSessionId) {
                continue
            }
            const payload: SandboxPrepareEvent = {
                type: "sandbox-prepare",
                phase: event.phase,
                workspaceDir: event.workspaceDir,
                ...(event.access === undefined ? {} : { access: event.access }),
                ...(event.elapsedMs === undefined ? {} : { elapsedMs: event.elapsedMs }),
                ...(event.error === undefined ? {} : { error: event.error }),
                ...(eventSessionId === null ? {} : { sessionId: eventSessionId }),
            }
            this.#appendEvent(turn, payload)
            delivered += 1
        }
        return delivered
    }

    /** 插话：宿主接收后回显 steer 事件 */
    async interject(conversationId: string, message: string): Promise<boolean> {
        const turn = this.#turns.get(conversationId)
        const text = typeof message === "string" ? message.trim() : ""
        if (turn === undefined || turn.done || turn.sessionId === null || text === "") {
            return false
        }
        const payload = text.length > this.#limits.maxMessageChars
            ? text.slice(0, this.#limits.maxMessageChars)
            : text
        let accepted: boolean
        try {
            accepted = await this.#agent.interject(turn.sessionId, payload)
        } catch (error) {
            this.#logger.warn?.({ conversationId, error: String(error) }, "插话失败")
            return false
        }
        if (!accepted || turn.done) {
            return accepted
        }
        const at = Date.now()
        this.#closeReasoning(turn)
        turn.blocks = [...turn.blocks, { type: "steer", text: payload, at }]
        this.#appendEvent(turn, { type: "steer", text: payload, at })
        this.#schedulePersist(turn)
        return true
    }

    /** 回答提问；accepted=false 表示已过期或不存在（stale） */
    async respondAsk(askId: string, answer: string): Promise<boolean> {
        const text = typeof answer === "string" ? answer.slice(0, MAX_ANSWER_CHARS) : ""
        const accepted = await this.#agent.respondAsk(askId, text)
        if (!accepted) {
            return false
        }
        const record = this.#requests.get(askId)
        if (record === undefined) {
            return true
        }
        this.#requests.delete(askId)
        this.#settleRequest(record, { type: "ask", request: null, askId })
        const turn = record.turn
        turn.blocks = turn.blocks.map((block) =>
            block.type === "ask" && block.askId === askId ? { ...block, answer: text } : block,
        )
        await this.#persistTurn(turn)
        return true
    }

    /** 审批应答；accepted=false 表示已过期或不存在（stale） */
    async respondApproval(approvalId: string, approved: boolean): Promise<boolean> {
        const accepted = await this.#agent.respondApproval(approvalId, approved === true)
        if (!accepted) {
            return false
        }
        const record = this.#requests.get(approvalId)
        if (record === undefined) {
            return true
        }
        this.#requests.delete(approvalId)
        this.#settleRequest(record, { type: "approval", request: null, approvalId })
        const turn = record.turn
        turn.blocks = turn.blocks.map((block) =>
            block.type === "approval" && block.approvalId === approvalId
                ? { ...block, approved: approved === true }
                : block,
        )
        await this.#persistTurn(turn)
        return true
    }

    /** 关闭所有订阅并尽力落盘进行中的轮次（插件 shutdown） */
    async dispose(): Promise<void> {
        const turns = [...this.#turns.values()]
        this.#turns.clear()
        this.#requests.clear()
        this.#starting.clear()
        for (const turn of turns) {
            this.#clearPersistTimer(turn)
            if (turn.retentionTimer !== null) {
                clearTimeout(turn.retentionTimer)
                turn.retentionTimer = null
            }
            this.#endListeners(turn)
            if (!turn.finalized) {
                turn.finalized = true
                turn.replaced = true
                turn.done = true
                turn.endedAt ??= Date.now()
                this.#settleBlocks(turn, turn.endedAt)
                turn.text = textOfBlocks(turn.blocks)
                turn.finalStatus = "interrupted"
                await this.#persistTurn(turn)
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* 内部：开始与桥接                                                     */
    /* ------------------------------------------------------------------ */

    async #beginTurn(
        conversationId: string,
        request: ChatRequest,
        stream: HttpStreamContext,
    ): Promise<void> {
        if (!isConversationId(conversationId)) {
            throw new ChatRuntimeError("invalid", "会话 id 不合法")
        }
        const message = typeof request.message === "string" ? request.message.trim() : ""
        if (message === "") {
            throw new ChatRuntimeError("invalid", "消息不能为空")
        }
        if (message.length > this.#limits.maxMessageChars) {
            throw new ChatRuntimeError("invalid", `消息超过 ${this.#limits.maxMessageChars} 字符`)
        }
        if (this.#starting.has(conversationId)) {
            throw new ChatRuntimeError("busy", "上一轮正在启动")
        }
        this.#starting.add(conversationId)
        try {
            const conversation = await this.#store.get(conversationId)
            if (conversation === null) {
                throw new ChatRuntimeError("not-found", "会话不存在")
            }
            const existing = this.#turns.get(conversationId)
            const sessionId = existing?.sessionId ?? conversation.sessionId
            const now = Date.now()
            const userMessageId = newMessageId()
            const assistantMessageId = newMessageId()
            const userMessage: StoredMessage = {
                id: userMessageId,
                role: "user",
                at: now,
                text: message,
                blocks: [],
                status: "done",
            }
            const assistantMessage: StoredMessage = {
                id: assistantMessageId,
                role: "assistant",
                at: now,
                text: "",
                blocks: [],
                status: "streaming",
                startedAt: now,
            }
            await this.#store.mutate(conversationId, (draft: ConversationDraft) => {
                if (sessionId !== null && draft.sessionId !== sessionId) {
                    draft.sessionId = sessionId
                }
                // 上次进程中断遗留的 streaming 消息收尾
                draft.messages = draft.messages.map((item) =>
                    item.status === "streaming" ? { ...item, status: "interrupted" } : item,
                )
                draft.messages.push(userMessage, assistantMessage)
            })

            if (existing !== undefined) {
                if (existing.finalized) {
                    this.#dropRetained(existing)
                } else {
                    this.#replaceTurn(existing)
                }
            }

            const turn: TurnState = {
                conversationId,
                startedAt: now,
                userMessageId,
                assistantMessageId,
                sessionId,
                events: [],
                chars: 0,
                truncated: false,
                done: false,
                stopped: false,
                replaced: false,
                finalized: false,
                endedAt: null,
                reply: "",
                text: "",
                blocks: [],
                turnNumber: 0,
                steps: 0,
                model: null,
                usage: null,
                error: null,
                finalStatus: null,
                listeners: new Set<HttpStreamContext>(),
                persistTimer: null,
                retentionTimer: null,
                stopRequested: false,
                stopPending: false,
            }
            turn.listeners.add(stream)
            this.#turns.set(conversationId, turn)
            this.#appendEvent(turn, {
                type: "accepted",
                conversationId,
                userMessageId,
                assistantMessageId,
                at: now,
            })
            void this.#runTurn(turn, conversation, request, message)
        } finally {
            this.#starting.delete(conversationId)
        }
    }

    async #runTurn(
        turn: TurnState,
        conversation: { readonly cwd: string | null; readonly permission: ChatPermission; readonly provider: string | null; readonly model: string | null; readonly reasoning: string | null },
        request: ChatRequest,
        message: string,
    ): Promise<void> {
        const input = this.#hostInput(turn, conversation, request, message)
        try {
            const result = await this.#agent.stream(input, (event) => {
                try {
                    this.#onHostEvent(turn, event)
                } catch (error) {
                    this.#logger.warn?.(
                        { conversationId: turn.conversationId, error: String(error) },
                        "流事件处理失败",
                    )
                }
            })
            if (turn.replaced) {
                await this.#finalize(turn, "interrupted")
                return
            }
            if (turn.stopped) {
                await this.#finalize(turn, "stopped")
                return
            }
            await this.#finalize(turn, "done", result)
        } catch (error) {
            if (turn.replaced) {
                await this.#finalize(turn, "interrupted")
                return
            }
            if (turn.stopped) {
                await this.#finalize(turn, "stopped")
                return
            }
            const mapping = mapChatError(error)
            turn.error = mapping.error
            this.#logger.warn?.({ conversationId: turn.conversationId, error: mapping.error }, "轮次失败")
            await this.#finalize(turn, "error", undefined, mapping)
        }
    }

    #hostInput(
        turn: TurnState,
        conversation: { readonly cwd: string | null; readonly permission: ChatPermission; readonly provider: string | null; readonly model: string | null; readonly reasoning: string | null },
        request: ChatRequest,
        message: string,
    ): HostAgentChatInput {
        const permission = isChatPermission(request.permission) ? request.permission : conversation.permission
        const provider = settingText(request.provider) ?? conversation.provider
        const model = settingText(request.model) ?? conversation.model
        const reasoning = settingText(request.reasoning) ?? conversation.reasoning
        const references = normalizeReferences(request.references, this.#limits.maxReferences)
        return {
            message,
            permission,
            ...(turn.sessionId === null ? {} : { sessionId: turn.sessionId }),
            ...(conversation.cwd === null ? {} : { cwd: conversation.cwd }),
            ...(references.length === 0 ? {} : { references }),
            ...(provider === null ? {} : { provider }),
            ...(model === null ? {} : { model }),
            ...(reasoning === null ? {} : { reasoning }),
        }
    }

    #onHostEvent(turn: TurnState, event: HostAgentStreamEvent): void {
        if (turn.replaced) {
            return
        }
        if (event.type === "session") {
            turn.sessionId = event.sessionId
            if (turn.stopped) {
                void this.#stopHost(turn)
                return
            }
            if (turn.done) {
                return
            }
            this.#appendEvent(turn, {
                type: "session",
                sessionId: event.sessionId,
                ...(typeof event.turn === "number" ? { turn: event.turn } : {}),
            })
            void this.#persistTurn(turn)
            return
        }
        if (turn.done) {
            return
        }
        switch (event.type) {
            case "step": {
                this.#closeReasoning(turn)
                turn.turnNumber = Math.max(turn.turnNumber, event.turn)
                turn.steps = Math.max(turn.steps, event.step)
                this.#appendEvent(turn, { type: "step", turn: event.turn, step: event.step })
                this.#schedulePersist(turn)
                break
            }
            case "delta": {
                if (event.text === "") {
                    return
                }
                this.#closeReasoning(turn)
                turn.reply += event.text
                this.#appendTextBlock(turn, event.text)
                this.#appendEvent(turn, { type: "delta", text: event.text })
                this.#schedulePersist(turn)
                break
            }
            case "reasoning": {
                if (event.text === "") {
                    return
                }
                this.#appendReasoningBlock(turn, event.text)
                this.#appendEvent(turn, { type: "reasoning", text: event.text })
                this.#schedulePersist(turn)
                break
            }
            case "tool": {
                this.#closeReasoning(turn)
                this.#applyToolEvent(turn, event)
                this.#appendEvent(turn, {
                    type: "tool",
                    id: event.id,
                    name: event.name,
                    phase: event.phase,
                    ...(event.arguments === undefined ? {} : { arguments: event.arguments }),
                    ...(event.ok === undefined ? {} : { ok: event.ok }),
                    ...(event.result === undefined ? {} : { result: event.result }),
                    ...(event.truncated === undefined ? {} : { truncated: event.truncated }),
                })
                this.#schedulePersist(turn)
                break
            }
            case "ask": {
                this.#closeReasoning(turn)
                const at = Date.now()
                const options = Array.isArray(event.request.options) ? [...event.request.options] : []
                const block: AskBlock = {
                    type: "ask",
                    askId: event.request.askId,
                    question: event.request.question,
                    options,
                    answer: null,
                    at,
                }
                turn.blocks = [...turn.blocks, block]
                const payload: AskRequestPayload = {
                    askId: event.request.askId,
                    question: event.request.question,
                    ...(options.length === 0 ? {} : { options }),
                }
                const index = this.#appendEvent(turn, {
                    type: "ask",
                    request: payload,
                    askId: event.request.askId,
                })
                this.#requests.set(event.request.askId, { turn, kind: "ask", index })
                this.#schedulePersist(turn)
                break
            }
            case "approval": {
                this.#closeReasoning(turn)
                const at = Date.now()
                const payload = approvalPayloadOf(event.request)
                const block: ApprovalBlock = {
                    type: "approval",
                    approvalId: event.request.approvalId,
                    command: event.request.command,
                    argv: [...event.request.argv],
                    cwd: event.request.cwd,
                    ...(event.request.currentPermission === undefined
                        ? {}
                        : { currentPermission: event.request.currentPermission }),
                    ...(event.request.requestedPermission === undefined
                        ? {}
                        : { requestedPermission: event.request.requestedPermission }),
                    ...(event.request.justification === undefined
                        ? {}
                        : { justification: event.request.justification }),
                    ...(event.request.network === undefined ? {} : { network: event.request.network }),
                    ...(event.request.background === undefined
                        ? {}
                        : { background: event.request.background }),
                    ...(event.request.stdin === undefined ? {} : { stdin: event.request.stdin }),
                    ...(event.request.timeoutMs === undefined ? {} : { timeoutMs: event.request.timeoutMs }),
                    approved: null,
                    at,
                }
                turn.blocks = [...turn.blocks, block]
                const index = this.#appendEvent(turn, {
                    type: "approval",
                    request: payload,
                    approvalId: event.request.approvalId,
                })
                this.#requests.set(event.request.approvalId, { turn, kind: "approval", index })
                this.#schedulePersist(turn)
                break
            }
        }
    }

    async #stopHost(turn: TurnState): Promise<void> {
        const sessionId = turn.sessionId
        if (sessionId === null) {
            turn.stopPending = true
            return
        }
        if (turn.stopRequested) {
            return
        }
        turn.stopRequested = true
        turn.stopPending = false
        try {
            await this.#agent.stop(sessionId)
        } catch (error) {
            this.#logger.warn?.(
                { conversationId: turn.conversationId, error: String(error) },
                "停止宿主轮次失败",
            )
        }
    }

    /* ------------------------------------------------------------------ */
    /* 内部：收尾与保留                                                     */
    /* ------------------------------------------------------------------ */

    async #finalize(
        turn: TurnState,
        outcome: TurnOutcome,
        result?: HostAgentChatResult,
        mapping?: ChatErrorMapping,
    ): Promise<void> {
        if (turn.finalized) {
            return
        }
        turn.finalized = true
        turn.done = true
        turn.endedAt ??= Date.now()
        this.#clearPersistTimer(turn)
        this.#clearRequests(turn)
        this.#settleBlocks(turn, turn.endedAt)
        turn.text = textOfBlocks(turn.blocks)

        let status: MessageStatus
        let terminal: ChatStreamEvent | null = null
        switch (outcome) {
            case "done": {
                status = "done"
                if (result !== undefined) {
                    turn.sessionId = result.sessionId
                    turn.turnNumber = result.turn
                    turn.steps = result.steps
                    turn.model = result.model
                    turn.usage = result.usage ?? null
                    terminal = {
                        type: "done",
                        sessionId: result.sessionId,
                        turn: result.turn,
                        steps: result.steps,
                        reply: result.reply,
                        model: result.model,
                        usage: result.usage ?? null,
                    }
                }
                break
            }
            case "error": {
                status = "error"
                turn.error = mapping?.error ?? "对话失败"
                terminal = {
                    type: "error",
                    error: turn.error,
                    ...(mapping === undefined ? {} : { code: mapping.code }),
                }
                break
            }
            case "stopped": {
                status = "stopped"
                break
            }
            case "interrupted": {
                status = "interrupted"
                break
            }
        }
        turn.finalStatus = status
        // 先落盘再发终态事件：客户端收到 done/error 时历史已可读
        await this.#persistTurn(turn)
        if (terminal !== null) {
            this.#appendEvent(turn, terminal)
        }
        this.#endListeners(turn)
        if (turn.replaced) {
            if (this.#turns.get(turn.conversationId) === turn) {
                this.#turns.delete(turn.conversationId)
            }
            return
        }
        this.#scheduleRetention(turn)
    }

    #replaceTurn(turn: TurnState): void {
        if (turn.replaced) {
            return
        }
        turn.replaced = true
        turn.done = true
        turn.endedAt ??= Date.now()
        this.#clearPersistTimer(turn)
        this.#clearRequests(turn)
        this.#appendEvent(turn, { type: "replaced" })
        this.#endListeners(turn)
        if (this.#turns.get(turn.conversationId) === turn) {
            this.#turns.delete(turn.conversationId)
        }
        void this.#finalize(turn, turn.stopped ? "stopped" : "interrupted")
    }

    #dropRetained(turn: TurnState): void {
        if (turn.retentionTimer !== null) {
            clearTimeout(turn.retentionTimer)
            turn.retentionTimer = null
        }
        if (this.#turns.get(turn.conversationId) === turn) {
            this.#turns.delete(turn.conversationId)
        }
    }

    #scheduleRetention(turn: TurnState): void {
        if (turn.replaced) {
            return
        }
        if (turn.retentionTimer !== null) {
            clearTimeout(turn.retentionTimer)
        }
        const timer = setTimeout(() => {
            turn.retentionTimer = null
            if (this.#turns.get(turn.conversationId) === turn) {
                this.#turns.delete(turn.conversationId)
            }
        }, TURN_RETENTION_MS)
        timer.unref()
        turn.retentionTimer = timer
        this.#pruneRetained(turn)
    }

    #pruneRetained(newest: TurnState): void {
        const retained: TurnState[] = []
        for (const turn of this.#turns.values()) {
            if (turn.finalized && turn !== newest) {
                retained.push(turn)
            }
        }
        retained.sort((left, right) => (left.endedAt ?? 0) - (right.endedAt ?? 0))
        while (retained.length + 1 > MAX_RETAINED_TURNS) {
            const old = retained.shift()
            if (old === undefined) {
                break
            }
            if (old.retentionTimer !== null) {
                clearTimeout(old.retentionTimer)
                old.retentionTimer = null
            }
            if (this.#turns.get(old.conversationId) === old) {
                this.#turns.delete(old.conversationId)
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* 内部：持久化                                                         */
    /* ------------------------------------------------------------------ */

    #schedulePersist(turn: TurnState): void {
        if (turn.finalized || turn.persistTimer !== null) {
            return
        }
        const timer = setTimeout(() => {
            turn.persistTimer = null
            void this.#persistTurn(turn)
        }, PERSIST_INTERVAL_MS)
        timer.unref()
        turn.persistTimer = timer
    }

    async #persistTurn(turn: TurnState): Promise<void> {
        this.#clearPersistTimer(turn)
        const status = turn.finalStatus ?? "streaming"
        const message: StoredMessage = {
            id: turn.assistantMessageId,
            role: "assistant",
            at: turn.startedAt,
            text: status === "streaming" ? "" : turn.text,
            blocks: [...turn.blocks],
            status,
            startedAt: turn.startedAt,
            ...(status === "streaming" ? {} : { endedAt: turn.endedAt ?? Date.now() }),
            ...(turn.error === null ? {} : { error: turn.error }),
            ...(turn.model === null ? {} : { model: turn.model }),
            ...(turn.turnNumber === 0 ? {} : { turn: turn.turnNumber }),
            ...(turn.steps === 0 ? {} : { steps: turn.steps }),
            ...(turn.usage === null ? {} : { usage: turn.usage }),
        }
        try {
            await this.#store.mutate(turn.conversationId, (draft: ConversationDraft) => {
                if (turn.sessionId !== null && draft.sessionId !== turn.sessionId) {
                    draft.sessionId = turn.sessionId
                }
                const index = draft.messages.findIndex((item) => item.id === turn.assistantMessageId)
                if (index === -1) {
                    return
                }
                draft.messages[index] = message
            })
        } catch (error) {
            if (error instanceof ChatStoreError) {
                this.#logger.warn?.({ conversationId: turn.conversationId, code: error.code }, "轮次持久化跳过")
                return
            }
            this.#logger.warn?.(
                { conversationId: turn.conversationId, error: String(error) },
                "轮次持久化失败",
            )
        }
    }

    #clearPersistTimer(turn: TurnState): void {
        if (turn.persistTimer !== null) {
            clearTimeout(turn.persistTimer)
            turn.persistTimer = null
        }
    }

    /* ------------------------------------------------------------------ */
    /* 内部：缓冲、事件与订阅                                               */
    /* ------------------------------------------------------------------ */

    /** 追加 chunk：正常入缓冲；超限则丢弃缓冲、发 truncated，实时推送继续 */
    #appendEvent(turn: TurnState, event: ChatStreamEvent): number {
        const chunk = serializeEvent(event)
        const events = turn.events
        let index = -1
        if (!turn.truncated && events !== null) {
            if (turn.chars + chunk.length > this.#limits.turnBufferChars) {
                turn.truncated = true
                turn.events = null
                turn.chars = 0
                this.#notify(turn, serializeEvent({ type: "truncated" }))
            } else {
                events.push(chunk)
                turn.chars += chunk.length
                index = events.length - 1
            }
        }
        this.#notify(turn, chunk)
        return index
    }

    #notify(turn: TurnState, chunk: string): void {
        for (const listener of [...turn.listeners]) {
            try {
                listener.write(chunk)
            } catch {
                turn.listeners.delete(listener)
                try {
                    listener.end()
                } catch {
                    /* 订阅方已断开 */
                }
            }
        }
    }

    #endListeners(turn: TurnState): void {
        for (const listener of [...turn.listeners]) {
            try {
                listener.end()
            } catch {
                /* 订阅方已断开 */
            }
        }
        turn.listeners.clear()
    }

    #write(stream: HttpStreamContext, chunk: string): boolean {
        try {
            stream.write(chunk)
            return true
        } catch {
            this.#end(stream)
            return false
        }
    }

    #end(stream: HttpStreamContext): void {
        try {
            stream.end()
        } catch {
            /* 流已关闭 */
        }
    }

    #settleRequest(
        record: RequestRecord,
        event: ChatStreamEvent,
    ): void {
        const turn = record.turn
        if (record.index < 0 || turn.events === null) {
            return
        }
        const previous = turn.events[record.index]
        if (previous === undefined) {
            return
        }
        const chunk = serializeEvent(event)
        turn.events[record.index] = chunk
        turn.chars = Math.max(0, turn.chars - previous.length + chunk.length)
    }

    #clearRequests(turn: TurnState): void {
        for (const [id, record] of [...this.#requests]) {
            if (record.turn === turn) {
                this.#requests.delete(id)
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* 内部：助手消息块                                                     */
    /* ------------------------------------------------------------------ */

    #appendTextBlock(turn: TurnState, text: string): void {
        const last = turn.blocks[turn.blocks.length - 1]
        if (last !== undefined && last.type === "text") {
            turn.blocks = [...turn.blocks.slice(0, -1), { type: "text", text: last.text + text }]
            return
        }
        turn.blocks = [...turn.blocks, { type: "text", text }]
    }

    #appendReasoningBlock(turn: TurnState, text: string): void {
        const last = turn.blocks[turn.blocks.length - 1]
        if (last !== undefined && last.type === "reasoning" && last.endedAt === null) {
            turn.blocks = [
                ...turn.blocks.slice(0, -1),
                { type: "reasoning", text: last.text + text, startedAt: last.startedAt, endedAt: null },
            ]
            return
        }
        turn.blocks = [...turn.blocks, { type: "reasoning", text, startedAt: Date.now(), endedAt: null }]
    }

    #closeReasoning(turn: TurnState): void {
        const last = turn.blocks[turn.blocks.length - 1]
        if (last !== undefined && last.type === "reasoning" && last.endedAt === null) {
            turn.blocks = [
                ...turn.blocks.slice(0, -1),
                { type: "reasoning", text: last.text, startedAt: last.startedAt, endedAt: Date.now() },
            ]
        }
    }

    #applyToolEvent(turn: TurnState, event: HostAgentStreamEvent & { type: "tool" }): void {
        const at = Date.now()
        if (event.phase === "start") {
            const block: ToolBlock = {
                type: "tool",
                id: event.id,
                name: event.name,
                phase: "start",
                ...(event.arguments === undefined ? {} : { arguments: event.arguments }),
                startedAt: at,
                endedAt: null,
                status: "running",
            }
            turn.blocks = [...turn.blocks, block]
            return
        }
        let found = false
        const next = turn.blocks.map((block) => {
            if (found || block.type !== "tool" || block.id !== event.id) {
                return block
            }
            found = true
            return {
                ...block,
                phase: "end" as const,
                ...(event.ok === undefined ? {} : { ok: event.ok }),
                ...(event.result === undefined ? {} : { result: event.result }),
                ...(event.truncated === undefined ? {} : { truncated: event.truncated }),
                endedAt: at,
                status: event.ok === false ? ("error" as const) : ("ok" as const),
            }
        })
        if (found) {
            turn.blocks = next
            return
        }
        turn.blocks = [
            ...turn.blocks,
            {
                type: "tool",
                id: event.id,
                name: event.name,
                phase: "end",
                ...(event.ok === undefined ? {} : { ok: event.ok }),
                ...(event.result === undefined ? {} : { result: event.result }),
                ...(event.truncated === undefined ? {} : { truncated: event.truncated }),
                startedAt: at,
                endedAt: at,
                status: event.ok === false ? "error" : "ok",
            },
        ]
    }

    /** 收尾未结束的思考/工具块 */
    #settleBlocks(turn: TurnState, at: number): void {
        turn.blocks = turn.blocks.map((block) => {
            if (block.type === "reasoning" && block.endedAt === null) {
                return { ...block, endedAt: at }
            }
            if (block.type === "tool" && block.status === "running") {
                return { ...block, endedAt: at, status: "error" as const }
            }
            return block
        })
    }
}

/* ---------------------------------------------------------------------- */
/* 错误映射                                                               */
/* ---------------------------------------------------------------------- */

const HOST_ERRORS: Readonly<Record<string, ChatErrorMapping>> = {
    "openai.missing-api-key": { error: "缺少 API Key", code: "missing-api-key" },
    "openai.empty-output": { error: "模型返回空内容", code: "empty-output" },
    "openai.timeout": { error: "模型请求超时", code: "model-timeout" },
    "openai.connection-failed": { error: "无法连接模型服务", code: "connection-failed" },
    "openai.unauthorized": { error: "模型服务鉴权失败", code: "unauthorized" },
    "openai.forbidden": { error: "模型服务拒绝访问", code: "forbidden" },
    "openai.rate-limited": { error: "模型服务限流", code: "rate-limited" },
    "openai.bad-request": { error: "模型请求参数非法", code: "bad-request" },
    "openai.server-error": { error: "模型服务内部错误", code: "server-error" },
    "openai.request-failed": { error: "模型请求失败", code: "model-request-failed" },
    "agent.failed": { error: "Agent 执行失败", code: "agent-failed" },
    "agent.empty-result": { error: "Agent 未返回结果", code: "empty-result" },
}

/** 宿主错误转中文；仅保留 message 的 RPC 通道，按文案前缀识别 */
export function mapChatError(error: unknown): ChatErrorMapping {
    const raw = error instanceof Error ? error.message : String(error)
    const message = raw.trim()
    if (message === "") {
        return { error: "对话失败", code: "chat-failed" }
    }
    const separator = message.indexOf(":")
    const base = separator === -1 ? message : message.slice(0, separator)
    const detail = separator === -1 ? "" : message.slice(separator + 1).trim()
    const known = HOST_ERRORS[base]
    if (known !== undefined) {
        return {
            error: detail === "" ? known.error : `${known.error}：${detail}`,
            code: known.code,
        }
    }
    if (message.includes("工作区不可用")) {
        return { error: message, code: "workspace-unavailable" }
    }
    if (message.includes("会话不存在") || message.includes("SessionNotFound")) {
        return { error: "宿主会话不存在，无法继续", code: "session-not-found" }
    }
    if (message.includes("插件没有 hostApi.agent 权限")) {
        return { error: "插件缺少 agent 权限", code: "agent-permission" }
    }
    if (message.includes("消息不能为空")) {
        return { error: "消息不能为空", code: "invalid-message" }
    }
    if (message.startsWith("permission 不合法")) {
        return { error: message, code: "invalid-permission" }
    }
    if (message.startsWith("host RPC 超时")) {
        return { error: "宿主响应超时", code: "host-timeout" }
    }
    return { error: message, code: "chat-failed" }
}

function runtimeErrorMapping(error: unknown): ChatErrorMapping {
    if (error instanceof ChatRuntimeError) {
        switch (error.code) {
            case "busy":
                return { error: error.message, code: "busy" }
            case "not-found":
                return { error: error.message, code: "conversation-not-found" }
            case "invalid":
                return { error: error.message, code: "invalid-request" }
        }
    }
    return mapChatError(error)
}

/* ---------------------------------------------------------------------- */
/* 工具                                                                   */
/* ---------------------------------------------------------------------- */

function serializeEvent(event: ChatStreamEvent): string {
    return `data: ${JSON.stringify(event)}\n\n`
}

function textOfBlocks(blocks: readonly Block[]): string {
    let text = ""
    for (const block of blocks) {
        if (block.type === "text") {
            text += block.text
        }
    }
    return text
}

function approvalPayloadOf(request: {
    readonly approvalId: string
    readonly command: string
    readonly argv: readonly string[]
    readonly cwd: string
    readonly currentPermission?: string
    readonly requestedPermission?: string
    readonly justification?: string
    readonly network?: boolean
    readonly background?: boolean
    readonly stdin?: string
    readonly timeoutMs?: number
}): ApprovalRequestPayload {
    return {
        approvalId: request.approvalId,
        command: request.command,
        argv: [...request.argv],
        cwd: request.cwd,
        ...(request.currentPermission === undefined ? {} : { currentPermission: request.currentPermission }),
        ...(request.requestedPermission === undefined
            ? {}
            : { requestedPermission: request.requestedPermission }),
        ...(request.justification === undefined ? {} : { justification: request.justification }),
        ...(request.network === undefined ? {} : { network: request.network }),
        ...(request.background === undefined ? {} : { background: request.background }),
        ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    }
}

function isChatPermission(value: unknown): value is ChatPermission {
    return value === "read-only" || value === "workspace-write" || value === "danger-full-access"
}

function settingText(value: string | null | undefined): string | null {
    if (typeof value !== "string") {
        return null
    }
    const text = value.trim()
    return text === "" ? null : text
}

function normalizeReferences(value: unknown, maxItems: number): string[] {
    if (!Array.isArray(value)) {
        return []
    }
    const references: string[] = []
    for (const item of value) {
        if (typeof item !== "string") {
            continue
        }
        const path = item.trim()
        if (path === "" || path.length > 512) {
            continue
        }
        references.push(path)
        if (references.length >= maxItems) {
            break
        }
    }
    return references
}

function newMessageId(): string {
    return `m${randomBase36(12)}`
}

function randomBase36(length: number): string {
    let result = ""
    while (result.length < length) {
        result += Math.random().toString(36).slice(2)
    }
    return result.slice(0, length)
}
