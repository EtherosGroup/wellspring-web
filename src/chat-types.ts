/*
 * 会话记录、过程块与流事件的共享类型
 *
 * 持久化在插件数据目录 chat/ 下；流事件与 HTTP 层一一对应。
 * 设计说明见 docs/ARCHITECTURE.md。
 */

/** 网页可选的 Agent 权限，与宿主 sandbox.access 取值一致 */
export type ChatPermission = "read-only" | "workspace-write" | "danger-full-access"

export const CHAT_PERMISSIONS: readonly ChatPermission[] = [
    "read-only",
    "workspace-write",
    "danger-full-access",
]

/** 推理强度；宿主按供应商支持情况校验 */
export type ReasoningLevel = "off" | "low" | "high" | "max"

export const REASONING_LEVELS: readonly ReasoningLevel[] = ["off", "low", "high", "max"]

/** 一轮的 token 用量；字段空值表示供应商没报告 */
export interface Usage {
    readonly inputTokens: number | null
    readonly outputTokens: number | null
    readonly cacheReadTokens?: number | null
    readonly cacheWriteTokens?: number | null
    readonly reasoningTokens?: number | null
    /** 收尾时最后一次请求占用的上下文 tokens */
    readonly contextTokens?: number | null
}

export type MessageStatus = "streaming" | "done" | "stopped" | "error" | "interrupted"

export type ToolPhase = "start" | "end"

export interface ToolBlock {
    readonly type: "tool"
    readonly id: string
    readonly name: string
    readonly phase: ToolPhase
    /** start 时为模型原始参数 JSON */
    readonly arguments?: string
    readonly ok?: boolean
    readonly result?: string
    readonly truncated?: boolean
    readonly startedAt: number
    readonly endedAt: number | null
    readonly status: "running" | "ok" | "error"
}

export interface ReasoningBlock {
    readonly type: "reasoning"
    readonly text: string
    readonly startedAt: number
    readonly endedAt: number | null
}

export interface AskBlock {
    readonly type: "ask"
    readonly askId: string
    readonly question: string
    readonly options: readonly string[]
    readonly answer: string | null
    readonly at: number
}

export interface ApprovalBlock {
    readonly type: "approval"
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
    readonly approved: boolean | null
    readonly at: number
}

export interface SteerBlock {
    readonly type: "steer"
    readonly text: string
    readonly at: number
}

export interface NoteBlock {
    readonly type: "note"
    readonly text: string
    readonly at: number
    readonly tone?: "info" | "warn"
}

export interface TextBlock {
    readonly type: "text"
    readonly text: string
}

export type Block =
    | TextBlock
    | ReasoningBlock
    | ToolBlock
    | AskBlock
    | ApprovalBlock
    | SteerBlock
    | NoteBlock

/** 用户消息 blocks 恒为空；助手消息按发生顺序保存正文/思考/工具/插话等 */
export interface StoredMessage {
    readonly id: string
    readonly role: "user" | "assistant"
    readonly at: number
    /** 用户消息正文；助手消息为已拼接的正文（不含思考/工具） */
    readonly text: string
    readonly blocks: readonly Block[]
    readonly status: MessageStatus
    readonly error?: string
    readonly usage?: Usage
    readonly model?: string
    readonly turn?: number
    readonly steps?: number
    readonly startedAt?: number
    readonly endedAt?: number
}

export interface LastMessagePreview {
    readonly role: "user" | "assistant"
    readonly text: string
    readonly at: number
    readonly status?: MessageStatus
}

/** 列表与索引里的会话摘要 */
export interface ConversationSummary {
    readonly id: string
    readonly title: string
    readonly createdAt: number
    readonly updatedAt: number
    /** 宿主会话 id；首轮 session 事件后写入 */
    readonly sessionId: string | null
    /** null 表示使用宿主当前工作目录 */
    readonly cwd: string | null
    readonly workspaceId: string | null
    readonly provider: string | null
    readonly model: string | null
    readonly reasoning: string | null
    readonly permission: ChatPermission
    readonly turns: number
    readonly steps: number
    readonly usage: Usage | null
    readonly last: LastMessagePreview | null
}

/** conversations/<id>.json 的完整记录 */
export interface StoredConversation extends ConversationSummary {
    readonly v: 1
    readonly messages: readonly StoredMessage[]
}

/** chat/index.json */
export interface ConversationIndex {
    readonly v: 1
    readonly activeId: string | null
    readonly conversations: readonly ConversationSummary[]
}

/** 发送一轮对话的请求体 */
export interface ChatRequest {
    readonly message: string
    readonly references?: readonly string[]
    readonly permission?: ChatPermission
    readonly provider?: string
    readonly model?: string
    readonly reasoning?: string
}

/* ------------------------------------------------------------------ */
/* SSE 事件：服务端 → 浏览器                                            */
/* ------------------------------------------------------------------ */

export interface AcceptedEvent {
    readonly type: "accepted"
    readonly conversationId: string
    readonly userMessageId: string
    readonly assistantMessageId: string
    readonly at: number
}

export interface SessionEvent {
    readonly type: "session"
    readonly sessionId: string
    readonly turn?: number
}

export interface StepEvent {
    readonly type: "step"
    readonly turn: number
    readonly step: number
}

export interface DeltaEvent {
    readonly type: "delta"
    readonly text: string
}

export interface ReasoningEvent {
    readonly type: "reasoning"
    readonly text: string
}

export interface ToolEvent {
    readonly type: "tool"
    readonly id: string
    readonly name: string
    readonly phase: ToolPhase
    readonly arguments?: string
    readonly ok?: boolean
    readonly result?: string
    readonly truncated?: boolean
}

export interface AskRequestPayload {
    readonly askId: string
    readonly question: string
    readonly options?: readonly string[]
}

/** request 为 null 表示这条提问已经答复或过期（续接重放时不再弹窗） */
export interface AskEvent {
    readonly type: "ask"
    readonly request: AskRequestPayload | null
    readonly askId: string
}

export interface ApprovalRequestPayload {
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
}

export interface ApprovalEvent {
    readonly type: "approval"
    readonly request: ApprovalRequestPayload | null
    readonly approvalId: string
}

export interface SteerEvent {
    readonly type: "steer"
    readonly text: string
    readonly at: number
}

export type SandboxPreparePhase = "started" | "completed" | "failed"

export interface SandboxPrepareEvent {
    readonly type: "sandbox-prepare"
    readonly phase: SandboxPreparePhase
    readonly workspaceDir?: string
    readonly access?: string
    readonly elapsedMs?: number
    readonly error?: string
    readonly sessionId?: string
}

export interface StoppedEvent {
    readonly type: "stopped"
    readonly at: number
}

export interface DoneEvent {
    readonly type: "done"
    readonly sessionId: string
    readonly turn: number
    readonly steps: number
    readonly reply: string
    readonly model: string
    readonly usage: Usage | null
}

export interface ErrorEvent {
    readonly type: "error"
    readonly error: string
    readonly code?: string
}

export interface TruncatedEvent {
    readonly type: "truncated"
}

export interface ReplacedEvent {
    readonly type: "replaced"
}

export interface ResumeEvent {
    readonly type: "resume"
    readonly active: boolean
    readonly from: number
    readonly total: number
}

export type ChatStreamEvent =
    | AcceptedEvent
    | SessionEvent
    | StepEvent
    | DeltaEvent
    | ReasoningEvent
    | ToolEvent
    | AskEvent
    | ApprovalEvent
    | SteerEvent
    | SandboxPrepareEvent
    | StoppedEvent
    | DoneEvent
    | ErrorEvent
    | TruncatedEvent
    | ReplacedEvent
    | ResumeEvent

/* ------------------------------------------------------------------ */
/* 限额                                                                 */
/* ------------------------------------------------------------------ */

export interface ChatLimits {
    readonly maxMessageChars: number
    readonly maxReferences: number
    readonly maxBodyBytes: number
    readonly maxConversations: number
    readonly maxConversationChars: number
    /** 单轮事件缓冲上限（字符） */
    readonly turnBufferChars: number
}

export const DEFAULT_CHAT_LIMITS: ChatLimits = {
    maxMessageChars: 32_000,
    maxReferences: 20,
    maxBodyBytes: 1_048_576,
    maxConversations: 100,
    maxConversationChars: 600_000,
    turnBufferChars: 4_000_000,
}
