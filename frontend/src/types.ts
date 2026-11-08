/*
 * 前端共享类型
 *
 * 与后端 src/chat-types.ts 对应；流事件、会话记录与接口响应都按这里约定。
 * 状态与动作见 store.ts。
 */

export type Permission = "read-only" | "workspace-write" | "danger-full-access"
export type ReasoningLevel = "off" | "low" | "high" | "max"
export type ThemePref = "system" | "light" | "dark"

export interface Usage {
    inputTokens: number | null
    outputTokens: number | null
    cacheReadTokens?: number | null
    cacheWriteTokens?: number | null
    reasoningTokens?: number | null
    contextTokens?: number | null
}

export type MessageStatus = "streaming" | "done" | "stopped" | "error" | "interrupted"

export interface TextBlock {
    type: "text"
    text: string
}

export interface ReasoningBlock {
    type: "reasoning"
    text: string
    startedAt: number
    endedAt: number | null
}

export interface ToolBlock {
    type: "tool"
    id: string
    name: string
    phase: "start" | "end"
    arguments?: string
    ok?: boolean
    result?: string
    truncated?: boolean
    startedAt: number
    endedAt: number | null
    status: "running" | "ok" | "error"
}

export interface AskBlock {
    type: "ask"
    askId: string
    question: string
    options: string[]
    answer: string | null
    at: number
}

export interface ApprovalBlock {
    type: "approval"
    approvalId: string
    command: string
    argv: string[]
    cwd: string
    currentPermission?: string
    requestedPermission?: string
    justification?: string
    network?: boolean
    background?: boolean
    stdin?: string
    timeoutMs?: number
    approved: boolean | null
    at: number
}

export interface SteerBlock {
    type: "steer"
    text: string
    at: number
}

export interface NoteBlock {
    type: "note"
    text: string
    at: number
    tone?: "info" | "warn"
}

export type Block =
    | TextBlock
    | ReasoningBlock
    | ToolBlock
    | AskBlock
    | ApprovalBlock
    | SteerBlock
    | NoteBlock

export interface ChatMessage {
    id: string
    role: "user" | "assistant"
    at: number
    text: string
    blocks: Block[]
    status: MessageStatus
    error?: string
    usage?: Usage
    model?: string
    turn?: number
    steps?: number
    startedAt?: number
    endedAt?: number
}

export interface ConversationSummary {
    id: string
    title: string
    createdAt: number
    updatedAt: number
    sessionId: string | null
    cwd: string | null
    workspaceId: string | null
    provider: string | null
    model: string | null
    reasoning: string | null
    permission: Permission
    turns: number
    steps: number
    usage: Usage | null
    last: {
        role: "user" | "assistant"
        text: string
        at: number
        status?: MessageStatus
    } | null
}

export interface Conversation extends ConversationSummary {
    v: 1
    messages: ChatMessage[]
}

/* ------------------------------ 宿主能力 ------------------------------ */

export interface ModelProvider {
    id: string
    name: string
    baseUrl: string | null
    models: string[]
    defaultModel: string | null
    apiKeyEnv: string | null
    builtin: boolean
    keyConfigured: boolean
    keySource: "env" | "credentials" | null
    keyMasked: string | null
    envVar: string | null
    keyStored: boolean
}

export interface ModelsState {
    providers: ModelProvider[]
    activeProvider: string
    activeModel: string | null
    activeReasoning: string
    reasoningLevels: string[]
}

export interface Workspace {
    id: string
    name: string
    root: string
    createdAt: number
    lastSeenAt: number
}

export interface HostInfo {
    status: string
    platform: string
    arch: string
    node: string
    cwd: string
}

export interface WorkspaceFileEntry {
    path: string
    name: string
    type: "file" | "directory"
}

export interface WorkspaceFilesResult {
    ok: boolean
    root: string
    entries: WorkspaceFileEntry[]
    truncated: boolean
    error?: string
}

export interface WorkspaceCheck {
    ok: boolean
    root: string
    name: string
    error?: string
}

export interface BootstrapResponse {
    version: string
    user: string | null
    host: HostInfo
    models: ModelsState | null
    workspaces: Workspace[]
    conversations: ConversationSummary[]
    activeId: string | null
    running: string[]
    limits: {
        maxMessageChars: number
        maxReferences: number
        maxBodyBytes: number
        maxConversations: number
        maxConversationChars: number
    }
}

/* ------------------------------ 流事件 ------------------------------ */

export type ChatEvent =
    | { type: "accepted"; conversationId: string; userMessageId: string; assistantMessageId: string; at: number }
    | { type: "session"; sessionId: string; turn?: number }
    | { type: "step"; turn: number; step: number }
    | { type: "delta"; text: string }
    | { type: "reasoning"; text: string }
    | {
          type: "tool"
          id: string
          name: string
          phase: "start" | "end"
          arguments?: string
          ok?: boolean
          result?: string
          truncated?: boolean
      }
    | { type: "ask"; request: { askId: string; question: string; options?: string[] } | null; askId: string }
    | {
          type: "approval"
          request: {
              approvalId: string
              command: string
              argv: string[]
              cwd: string
              currentPermission?: string
              requestedPermission?: string
              justification?: string
              network?: boolean
              background?: boolean
              stdin?: string
              timeoutMs?: number
          } | null
          approvalId: string
      }
    | { type: "steer"; text: string; at: number }
    | { type: "sandbox-prepare"; phase: "started" | "completed" | "failed"; workspaceDir?: string; elapsedMs?: number; error?: string }
    | { type: "stopped"; at: number }
    | { type: "done"; sessionId: string; turn: number; steps: number; reply: string; model: string; usage: Usage | null }
    | { type: "error"; error: string; code?: string }
    | { type: "truncated" }
    | { type: "replaced" }
    | { type: "resume"; active: boolean; from: number; total: number }

export type ToastTone = "info" | "success" | "error"

export interface Toast {
    id: number
    text: string
    tone: ToastTone
}

export type DraftMap = Record<string, string>
