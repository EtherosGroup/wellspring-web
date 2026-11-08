/*
 * 全局状态与动作
 *
 * 组件只读写这里的单例 store、调用 actions；不直接使用 api.ts 的流接口。
 * 流式事件在本模块内应用到 ChatMessage.blocks（正文/思考/工具/提问/审批/插话）。
 * 断线、切后台、刷新页面时的续接策略见 docs/ARCHITECTURE.md 8.2。
 */

import { reactive } from "vue"

import { ApiError, api, openChatStream, openResumeStream, type StreamHandle } from "./api"
import { addEventToMessage, closeMessage } from "./lib/blocks"
import type {
    BootstrapResponse,
    Block,
    ChatEvent,
    ChatMessage,
    Conversation,
    ConversationSummary,
    HostInfo,
    ModelsState,
    Permission,
    ReasoningLevel,
    ThemePref,
    Toast,
    ToastTone,
    Workspace,
    WorkspaceFileEntry,
} from "./types"

/* ------------------------------ 常量 ------------------------------ */

const DRAFTS_KEY = "wellspring.web.drafts"
const THEME_KEY = "wellspring.web.theme"
const PERMISSION_KEY = "wellspring.web.permission"
const WORKSPACE_KEY = "wellspring.web.workspace"
const INSPECTOR_KEY = "wellspring.web.inspector"
const THEME_COOKIE = "wellspring_web_theme"

/* 续接退避：0.6 / 1.2 / 2.4 秒，最多 3 次 */
const RECONNECT_DELAYS = [600, 1200, 2400] as const
const RECONNECT_MAX = 3
/* 停止后等待 stopped 事件的兜底时长 */
const STOP_FALLBACK_MS = 3000
const TOAST_TTL = 4200
const RUNNING_POLL_MS = 30000

/* ------------------------------ 状态 ------------------------------ */

export interface AppState {
    ready: boolean
    error: string | null
    version: string
    user: string | null
    host: HostInfo | null
    models: ModelsState | null
    workspaces: Workspace[]
    /** 新建会话默认绑定的工作区 */
    workspaceId: string | null
    conversations: ConversationSummary[]
    activeId: string | null
    conversation: Conversation | null
    running: Record<string, boolean>
    /** 当前会话是否有活跃轮次 */
    streaming: boolean
    /** 活跃流对应的宿主会话 id（session 事件） */
    streamSessionId: string | null
    draft: string
    drafts: Record<string, string>
    theme: ThemePref
    /** 新会话默认权限（本地偏好） */
    defaultPermission: Permission
    sidebarOpen: boolean
    inspectorOpen: boolean
    settingsOpen: boolean
    toasts: Toast[]
    limits: BootstrapResponse["limits"] | null
}

export const store = reactive<AppState>({
    ready: false,
    error: null,
    version: "",
    user: null,
    host: null,
    models: null,
    workspaces: [],
    workspaceId: null,
    conversations: [],
    activeId: null,
    conversation: null,
    running: {},
    streaming: false,
    streamSessionId: null,
    draft: "",
    drafts: {},
    theme: "system",
    defaultPermission: "workspace-write",
    sidebarOpen: false,
    inspectorOpen: false,
    settingsOpen: false,
    toasts: [],
    limits: null,
})

/* ------------------------------ 内部状态 ------------------------------ */

interface ActiveStream {
    conversationId: string
    /** 流事件作用的目标会话（可能已不是 store.conversation） */
    target: Conversation
    /** 当前助手消息 id（本地占位，accepted 后换成服务端 id） */
    assistantId: string
    handle: StreamHandle | null
    /** 已应用的数据事件数 == 服务端缓冲下标 */
    received: number
    attempts: number
    terminal: boolean
    /** 后台主动断流（可见性切换/页面离开），不算错误 */
    hidden: boolean
    truncated: boolean
    stopRequested: boolean
    stopTimer: number | null
    resumeTimer: number | null
}

let active: ActiveStream | null = null
let pendingSend = false
let draftTimer: number | null = null
let toastSeq = 0
let themeMedia: MediaQueryList | null = null

/* ------------------------------ 工具函数 ------------------------------ */

function uid(): string {
    return Math.random().toString(36).slice(2, 10)
}

function now(): number {
    return Date.now()
}

function errorText(error: unknown): string {
    if (error instanceof ApiError) {
        return error.message
    }
    if (error instanceof Error && error.message !== "") {
        return error.message
    }
    return "网络请求失败"
}

function readJson<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key)
        if (raw === null || raw === "") {
            return fallback
        }
        return JSON.parse(raw) as T
    } catch {
        return fallback
    }
}

function writeJson(key: string, value: unknown): void {
    try {
        localStorage.setItem(key, JSON.stringify(value))
    } catch {
        /* 存储不可用 */
    }
}

function lastItem<T>(list: T[]): T | undefined {
    return list.length > 0 ? list[list.length - 1] : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}

/* ------------------------------ 展示辅助 ------------------------------ */

export function formatRelativeTime(at: number): string {
    const delta = now() - at
    if (delta < 60_000) {
        return "刚刚"
    }
    if (delta < 3_600_000) {
        return `${Math.floor(delta / 60_000)} 分钟前`
    }
    if (delta < 86_400_000) {
        return `${Math.floor(delta / 3_600_000)} 小时前`
    }
    const date = new Date(at)
    const today = new Date()
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
    const target = new Date(date.getFullYear(), date.getMonth(), date.getDate())
    if (target.getTime() === yesterday.getTime()) {
        return "昨天"
    }
    if (delta < 7 * 86_400_000) {
        return `${Math.floor(delta / 86_400_000)} 天前`
    }
    return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

export type DayBucket = "today" | "yesterday" | "earlier"

export function dayBucket(at: number): DayBucket {
    const date = new Date(at)
    const today = new Date()
    const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
    const startYesterday = startToday - 86_400_000
    if (at >= startToday) {
        return "today"
    }
    if (at >= startYesterday) {
        return "yesterday"
    }
    return "earlier"
}

export function formatTokens(value: number | null | undefined): string {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return "—"
    }
    if (value >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(1)}m`
    }
    if (value >= 1_000) {
        return `${(value / 1_000).toFixed(1)}k`
    }
    return String(value)
}

export function formatDuration(ms: number): string {
    if (ms < 1000) {
        return `${Math.round(ms)}ms`
    }
    if (ms < 60_000) {
        return `${(ms / 1000).toFixed(1)}s`
    }
    const minutes = Math.floor(ms / 60_000)
    const seconds = Math.round((ms % 60_000) / 1000)
    return `${minutes}m${seconds}s`
}

export function permissionLabel(permission: Permission | string | null): string {
    switch (permission) {
        case "read-only":
            return "只读"
        case "workspace-write":
            return "工作区写入"
        case "danger-full-access":
            return "完全访问"
        default:
            return "未设置"
    }
}

export function reasoningLabel(reasoning: string | null): string {
    switch (reasoning) {
        case "off":
            return "关"
        case "low":
            return "低"
        case "high":
            return "高"
        case "max":
            return "最高"
        default:
            return reasoning ?? "默认"
    }
}

export function themeLabel(theme: ThemePref): string {
    switch (theme) {
        case "light":
            return "浅色"
        case "dark":
            return "深色"
        default:
            return "跟随系统"
    }
}

/** 会话当前模型的可读名：provider 名 / model */
export function conversationModelLabel(conversation: ConversationSummary | Conversation | null): string {
    if (conversation === null) {
        return "默认模型"
    }
    const model = conversation.model ?? store.models?.activeModel ?? ""
    if (model === "") {
        return "默认模型"
    }
    const providerId = conversation.provider ?? store.models?.activeProvider ?? ""
    const provider = store.models?.providers.find((item) => item.id === providerId)
    if (provider !== undefined && provider.name !== "") {
        return `${provider.name} / ${model}`
    }
    return model
}

/* ------------------------------ 主题 ------------------------------ */

function resolveTheme(pref: ThemePref): "light" | "dark" {
    if (pref === "light" || pref === "dark") {
        return pref
    }
    if (themeMedia === null) {
        themeMedia = window.matchMedia("(prefers-color-scheme: dark)")
    }
    return themeMedia.matches ? "dark" : "light"
}

function applyTheme(): void {
    const resolved = resolveTheme(store.theme)
    document.documentElement.dataset["theme"] = resolved
}

function readCookie(name: string): string | null {
    const prefix = `${name}=`
    for (const part of document.cookie.split(";")) {
        const item = part.trim()
        if (item.startsWith(prefix)) {
            return decodeURIComponent(item.slice(prefix.length))
        }
    }
    return null
}

function loadThemePref(): ThemePref {
    try {
        const saved = localStorage.getItem(THEME_KEY)
        if (saved === "light" || saved === "dark" || saved === "system") {
            return saved
        }
    } catch {
        /* 存储不可用 */
    }
    /* 服务端按 cookie 预注入主题；localStorage 缺失时沿用 */
    const cookie = readCookie(THEME_COOKIE)
    if (cookie === "light" || cookie === "dark") {
        return cookie
    }
    return "system"
}

export function setTheme(theme: ThemePref): void {
    store.theme = theme
    try {
        localStorage.setItem(THEME_KEY, theme)
    } catch {
        /* 存储不可用 */
    }
    if (theme === "system") {
        document.cookie = `${THEME_COOKIE}=; path=/; max-age=0; samesite=lax`
    } else {
        document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=31536000; samesite=lax`
    }
    applyTheme()
}

function watchSystemTheme(): void {
    themeMedia = window.matchMedia("(prefers-color-scheme: dark)")
    themeMedia.addEventListener("change", () => {
        if (store.theme === "system") {
            applyTheme()
        }
    })
}

/* ------------------------------ 草稿 ------------------------------ */

function draftKey(): string {
    return store.activeId ?? "new"
}

function loadDrafts(): void {
    store.drafts = readJson<Record<string, string>>(DRAFTS_KEY, {})
    store.draft = store.drafts[draftKey()] ?? ""
}

function persistDrafts(): void {
    if (draftTimer !== null) {
        window.clearTimeout(draftTimer)
    }
    draftTimer = window.setTimeout(() => {
        draftTimer = null
        writeJson(DRAFTS_KEY, store.drafts)
    }, 300)
}

export function setDraft(text: string): void {
    store.draft = text
    store.drafts[draftKey()] = text
    persistDrafts()
}

function clearDraft(key: string): void {
    store.drafts[key] = ""
    if (draftKey() === key) {
        store.draft = ""
    }
    persistDrafts()
}

function restoreDraft(): void {
    store.draft = store.drafts[draftKey()] ?? ""
}

/* ------------------------------ Toast ------------------------------ */

export function toast(text: string, tone: ToastTone = "info"): void {
    const entry: Toast = { id: ++toastSeq, text, tone }
    store.toasts.push(entry)
    window.setTimeout(() => {
        dismissToast(entry.id)
    }, TOAST_TTL)
}

export function dismissToast(id: number): void {
    const index = store.toasts.findIndex((item) => item.id === id)
    if (index >= 0) {
        store.toasts.splice(index, 1)
    }
}

/* ------------------------------ 摘要同步 ------------------------------ */

function syncSummary(conversation: Conversation): void {
    const summary = store.conversations.find((item) => item.id === conversation.id)
    if (summary === undefined) {
        return
    }
    summary.title = conversation.title
    summary.updatedAt = conversation.updatedAt
    summary.sessionId = conversation.sessionId
    summary.cwd = conversation.cwd
    summary.workspaceId = conversation.workspaceId
    summary.provider = conversation.provider
    summary.model = conversation.model
    summary.reasoning = conversation.reasoning
    summary.permission = conversation.permission
    summary.turns = conversation.turns
    summary.steps = conversation.steps
    summary.usage = conversation.usage
    summary.last = conversation.last
    sortConversations()
}

function sortConversations(): void {
    store.conversations.sort((a, b) => b.updatedAt - a.updatedAt)
}

/* ------------------------------ 流事件应用 ------------------------------ */

function assistantMessage(stream: ActiveStream): ChatMessage | null {
    const message = stream.target.messages.find((item) => item.id === stream.assistantId)
    if (message !== undefined) {
        return message
    }
    const fallback = lastItem(stream.target.messages)
    if (fallback !== undefined && fallback.role === "assistant") {
        stream.assistantId = fallback.id
        return fallback
    }
    return null
}

function ensureAssistant(stream: ActiveStream): ChatMessage {
    const existing = assistantMessage(stream)
    if (existing !== null) {
        return existing
    }
    const message: ChatMessage = {
        id: stream.assistantId,
        role: "assistant",
        at: now(),
        text: "",
        blocks: [],
        status: "streaming",
        startedAt: now(),
    }
    stream.target.messages.push(message)
    return message
}

function applyEvent(stream: ActiveStream, event: ChatEvent): void {
    const message = ensureAssistant(stream)
    switch (event.type) {
        case "accepted": {
            const localUser = stream.target.messages.find(
                (item) => item.role === "user" && item.id.startsWith("local-"),
            )
            if (localUser !== undefined) {
                localUser.id = event.userMessageId
            }
            message.id = event.assistantMessageId
            stream.assistantId = event.assistantMessageId
            message.startedAt = message.startedAt ?? event.at
            return
        }
        case "session": {
            stream.target.sessionId = event.sessionId
            syncSummary(stream.target)
            if (store.activeId === stream.conversationId) {
                store.streamSessionId = event.sessionId
            }
            return
        }
        case "step": {
            addEventToMessage(message, event, now())
            stream.target.turns = Math.max(stream.target.turns, event.turn)
            stream.target.steps = Math.max(stream.target.steps, event.step)
            syncSummary(stream.target)
            return
        }
        case "done": {
            addEventToMessage(message, event, now())
            stream.target.turns = Math.max(stream.target.turns, event.turn)
            stream.target.steps = Math.max(stream.target.steps, event.steps)
            if (event.usage !== null) {
                stream.target.usage = event.usage
            }
            stream.target.last = {
                role: "assistant",
                text: message.text.slice(0, 160),
                at: now(),
                status: "done",
            }
            finalizeStream(stream, "done")
            return
        }
        case "stopped": {
            addEventToMessage(message, event, now())
            finalizeStream(stream, "stopped")
            return
        }
        case "error": {
            addEventToMessage(message, event, now())
            finalizeStream(stream, "error")
            return
        }
        case "truncated": {
            stream.truncated = true
            addEventToMessage(message, event, now())
            return
        }
        case "replaced": {
            addEventToMessage(message, event, now())
            finalizeStream(stream, "interrupted")
            return
        }
        case "resume": {
            /* 续接标记：序号校正由 handlersFor 处理 */
            return
        }
        default: {
            addEventToMessage(message, event, now())
        }
    }
}

/* ------------------------------ 流生命周期 ------------------------------ */

function handlersFor(stream: ActiveStream) {
    return {
        onEvent: (event: ChatEvent): void => {
            if (stream.terminal) {
                return
            }
            if (event.type === "resume") {
                if (event.from !== stream.received) {
                    resetAssistant(stream)
                    stream.received = event.from
                }
                return
            }
            stream.received += 1
            stream.attempts = 0
            applyEvent(stream, event)
        },
        onClose: (): void => {
            if (!stream.terminal && !stream.hidden) {
                scheduleResume(stream)
            }
        },
        onNetworkError: (): void => {
            if (!stream.terminal && !stream.hidden) {
                scheduleResume(stream)
            }
        },
    }
}

function resetAssistant(stream: ActiveStream): void {
    const message = assistantMessage(stream)
    if (message === null) {
        return
    }
    message.blocks = []
    message.text = ""
    message.status = "streaming"
    message.error = undefined
    message.usage = undefined
    stream.target.turns = 0
    stream.target.steps = 0
}

function clearStreamTimers(stream: ActiveStream): void {
    if (stream.resumeTimer !== null) {
        window.clearTimeout(stream.resumeTimer)
        stream.resumeTimer = null
    }
    if (stream.stopTimer !== null) {
        window.clearTimeout(stream.stopTimer)
        stream.stopTimer = null
    }
}

function detachStream(stream: ActiveStream): void {
    clearStreamTimers(stream)
    stream.hidden = true
    const handle = stream.handle
    stream.handle = null
    handle?.abort()
}

function finalizeStream(stream: ActiveStream, status: ChatMessage["status"]): void {
    if (stream.terminal) {
        return
    }
    stream.terminal = true
    clearStreamTimers(stream)
    const handle = stream.handle
    stream.handle = null
    handle?.abort()
    const message = assistantMessage(stream)
    if (message !== null) {
        closeMessage(message, status)
    }
    stream.target.updatedAt = now()
    syncSummary(stream.target)
    store.running[stream.conversationId] = false
    if (active === stream) {
        active = null
    }
    syncStreaming()
    void refreshConversations()
}

function markInterrupted(stream: ActiveStream, reason: string): void {
    if (stream.terminal) {
        return
    }
    const message = assistantMessage(stream)
    if (message !== null) {
        closeMessage(message, "interrupted")
        message.error = reason
    }
    stream.terminal = true
    clearStreamTimers(stream)
    const handle = stream.handle
    stream.handle = null
    handle?.abort()
    /* 服务端轮次可能仍在运行，running 保持 true，刷新后可续接 */
    store.running[stream.conversationId] = true
    if (active === stream) {
        active = null
    }
    syncStreaming()
    toast(reason, "error")
}

function scheduleResume(stream: ActiveStream): void {
    if (stream.terminal) {
        return
    }
    if (stream.truncated || stream.attempts >= RECONNECT_MAX) {
        markInterrupted(stream, "连接中断，刷新页面可续接")
        return
    }
    const delay = RECONNECT_DELAYS[stream.attempts] ?? 2400
    stream.attempts += 1
    const handle = stream.handle
    stream.handle = null
    handle?.abort()
    if (stream.resumeTimer !== null) {
        window.clearTimeout(stream.resumeTimer)
    }
    stream.resumeTimer = window.setTimeout(() => {
        stream.resumeTimer = null
        void attemptResume(stream)
    }, delay)
}

async function attemptResume(stream: ActiveStream): Promise<void> {
    if (stream.terminal || active !== stream) {
        return
    }
    stream.hidden = false
    try {
        const result = await openResumeStream(stream.conversationId, stream.received, handlersFor(stream))
        if ("kind" in result) {
            if (stream.terminal) {
                result.handle.abort()
                return
            }
            stream.handle = result.handle
            if (stream.hidden || stream.terminal) {
                detachStream(stream)
            }
            return
        }
        /* 服务端已无可续接轮次 */
        await reconcile(stream)
    } catch {
        if (!stream.terminal) {
            scheduleResume(stream)
        }
    }
}

/** 拉取服务端最终状态，结束本地流 */
async function reconcile(stream: ActiveStream): Promise<void> {
    if (stream.terminal) {
        return
    }
    stream.terminal = true
    clearStreamTimers(stream)
    const handle = stream.handle
    stream.handle = null
    handle?.abort()
    try {
        const { conversation, running } = await api.getConversation(stream.conversationId)
        store.running[stream.conversationId] = running
        if (store.activeId === stream.conversationId) {
            store.conversation = conversation
        }
        syncSummary(conversation)
    } catch {
        store.running[stream.conversationId] = false
        const message = assistantMessage(stream)
        if (message !== null && message.status === "streaming") {
            message.status = "interrupted"
            message.error = "连接中断"
            message.endedAt = now()
        }
    }
    if (active === stream) {
        active = null
    }
    syncStreaming()
    void refreshConversations()
}

/* ------------------------------ 流式订阅 ------------------------------ */

function syncStreaming(): void {
    const isCurrent = active !== null && store.activeId === active.conversationId
    store.streaming = isCurrent
    if (!isCurrent) {
        store.streamSessionId = null
    } else if (store.conversation !== null) {
        store.streamSessionId = store.conversation.sessionId
    }
}

interface BeginTurnInput {
    message: string
    references: string[]
}

async function beginTurn(conversation: Conversation, input: BeginTurnInput): Promise<void> {
    const at = now()
    const assistantId = `local-a-${uid()}`
    const userMessage: ChatMessage = {
        id: `local-u-${uid()}`,
        role: "user",
        at,
        text: input.message,
        blocks: [],
        status: "done",
    }
    const assistantPlaceholder: ChatMessage = {
        id: assistantId,
        role: "assistant",
        at: at + 1,
        text: "",
        blocks: [],
        status: "streaming",
        startedAt: at + 1,
        turn: conversation.turns + 1,
        steps: 0,
    }
    conversation.messages.push(userMessage, assistantPlaceholder)
    conversation.updatedAt = at
    conversation.last = { role: "user", text: input.message.slice(0, 160), at, status: "done" }
    syncSummary(conversation)
    clearDraft(conversation.id)

    const stream: ActiveStream = {
        conversationId: conversation.id,
        target: conversation,
        assistantId,
        handle: null,
        received: 0,
        attempts: 0,
        terminal: false,
        hidden: false,
        truncated: false,
        stopRequested: false,
        stopTimer: null,
        resumeTimer: null,
    }
    active = stream
    store.running[conversation.id] = true
    syncStreaming()

    try {
        const handle = await openChatStream(
            conversation.id,
            {
                message: input.message,
                references: input.references,
                permission: conversation.permission,
            },
            handlersFor(stream),
        )
        if (stream.terminal) {
            handle.abort()
            return
        }
        stream.handle = handle
        if (stream.hidden) {
            detachStream(stream)
        }
    } catch (error) {
        const message = assistantMessage(stream)
        if (message !== null) {
            message.status = "error"
            message.error = errorText(error)
            message.endedAt = now()
        }
        stream.terminal = true
        clearStreamTimers(stream)
        if (active === stream) {
            active = null
        }
        store.running[conversation.id] = false
        syncStreaming()
        toast(errorText(error), "error")
        void refreshConversations()
    }
}

/** 为运行中的会话重建订阅（页面加载 / 刷新后） */
async function resumeRunning(conversation: Conversation): Promise<void> {
    const last = lastItem(conversation.messages)
    let assistant: ChatMessage
    if (last !== undefined && last.role === "assistant") {
        assistant = last
    } else {
        assistant = {
            id: `local-a-${uid()}`,
            role: "assistant",
            at: now(),
            text: "",
            blocks: [],
            status: "streaming",
            startedAt: now(),
        }
        conversation.messages.push(assistant)
    }
    assistant.blocks = []
    assistant.text = ""
    assistant.status = "streaming"
    assistant.error = undefined

    const stream: ActiveStream = {
        conversationId: conversation.id,
        target: conversation,
        assistantId: assistant.id,
        handle: null,
        received: 0,
        attempts: 0,
        terminal: false,
        hidden: false,
        truncated: false,
        stopRequested: false,
        stopTimer: null,
        resumeTimer: null,
    }
    active = stream
    store.running[conversation.id] = true
    syncStreaming()
    await attemptResume(stream)
}

/* ------------------------------ 可见性 / 网络 ------------------------------ */

function bindLifecycle(): void {
    document.addEventListener("visibilitychange", () => {
        if (active === null || active.terminal) {
            return
        }
        if (document.visibilityState === "hidden") {
            detachStream(active)
            return
        }
        const stream = active
        stream.hidden = false
        if (stream.handle === null && stream.resumeTimer === null) {
            stream.attempts = 0
            void attemptResume(stream)
        }
    })
    window.addEventListener("pagehide", () => {
        if (active !== null && !active.terminal) {
            detachStream(active)
        }
    })
    window.addEventListener("online", () => {
        if (active !== null && !active.terminal && active.handle === null) {
            active.attempts = 0
            void attemptResume(active)
        }
    })
}

function pollRunning(): void {
    window.setInterval(() => {
        if (document.visibilityState === "hidden" || store.ready !== true) {
            return
        }
        void (async () => {
            try {
                const result = await api.running()
                const ids = new Set(result.running.map((item) => item.conversationId))
                for (const summary of store.conversations) {
                    const live = ids.has(summary.id)
                    if (!live && active?.conversationId !== summary.id) {
                        store.running[summary.id] = false
                    } else if (live) {
                        store.running[summary.id] = true
                    }
                }
                syncStreaming()
            } catch {
                /* 轮询失败静默 */
            }
        })()
    }, RUNNING_POLL_MS)
}

/* ------------------------------ 核心动作 ------------------------------ */

export async function bootstrap(): Promise<void> {
    store.ready = false
    store.error = null
    try {
        const state = await api.bootstrap()
        store.version = state.version
        store.user = state.user
        store.host = state.host
        store.models = state.models
        store.workspaces = state.workspaces
        store.conversations = state.conversations
        store.limits = state.limits
        store.activeId = state.activeId
        store.running = {}
        for (const id of state.running) {
            store.running[id] = true
        }
        restoreWorkspace()
        if (state.activeId !== null) {
            await openConversation(state.activeId)
        }
        sortConversations()
        store.ready = true
    } catch (error) {
        store.error = errorText(error)
        store.ready = true
    }
}

function restoreWorkspace(): void {
    let saved: string | null = null
    try {
        saved = localStorage.getItem(WORKSPACE_KEY)
    } catch {
        saved = null
    }
    const known = store.workspaces.find((item) => item.id === saved)
    if (known !== undefined) {
        store.workspaceId = known.id
        return
    }
    const first = store.workspaces[0]
    store.workspaceId = first !== undefined ? first.id : null
}

export async function refreshConversations(): Promise<void> {
    try {
        const state = await api.conversations()
        store.conversations = state.conversations
        if (store.activeId === null && state.activeId !== null) {
            store.activeId = state.activeId
        }
        if (store.conversation !== null) {
            const summary = store.conversations.find((item) => item.id === store.conversation?.id)
            if (summary !== undefined) {
                store.conversation.updatedAt = summary.updatedAt
                store.conversation.title = summary.title
                store.conversation.last = summary.last
            }
        }
        sortConversations()
    } catch (error) {
        toast(errorText(error), "error")
    }
}

export async function openConversation(id: string): Promise<void> {
    if (store.activeId === id && store.conversation?.id === id) {
        syncStreaming()
        return
    }
    if (active !== null && active.conversationId !== id) {
        detachStream(active)
        active = null
    }
    try {
        const { conversation, running } = await api.getConversation(id)
        store.activeId = id
        store.conversation = conversation
        /* 续接必须作用在 reactive 代理上，否则流事件不触发重渲染 */
        const target = store.conversation
        store.running[id] = running || store.running[id] === true
        restoreDraft()
        syncStreaming()
        if (running && target !== null) {
            await resumeRunning(target)
        } else if (conversation.messages.length > 0) {
            const last = lastItem(conversation.messages)
            if (last !== undefined && last.status === "streaming") {
                last.status = "interrupted"
                last.error = "上一轮已中断"
            }
        }
        void api.setActiveConversation(id).catch(() => {
            /* 记录 active 失败不影响当前视图 */
        })
    } catch (error) {
        toast(errorText(error), "error")
    }
}

export async function newConversation(input?: { cwd?: string; workspaceId?: string }): Promise<void> {
    if (active !== null) {
        detachStream(active)
        active = null
    }
    try {
        const body: {
            cwd?: string
            workspaceId?: string
            permission?: Permission
        } = { permission: store.defaultPermission }
        const workspaceId = input?.workspaceId ?? store.workspaceId
        if (workspaceId !== null) {
            body.workspaceId = workspaceId
        }
        if (input?.cwd !== undefined) {
            body.cwd = input.cwd
        }
        const { conversation } = await api.createConversation(body)
        store.conversation = conversation
        store.activeId = conversation.id
        store.running[conversation.id] = false
        const summary = toSummary(conversation)
        store.conversations.unshift(summary)
        sortConversations()
        restoreDraft()
        syncStreaming()
        store.sidebarOpen = false
        void api.setActiveConversation(conversation.id).catch(() => {
            /* 记录 active 失败不影响当前视图 */
        })
    } catch (error) {
        toast(errorText(error), "error")
    }
}

function toSummary(conversation: Conversation): ConversationSummary {
    return {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        sessionId: conversation.sessionId,
        cwd: conversation.cwd,
        workspaceId: conversation.workspaceId,
        provider: conversation.provider,
        model: conversation.model,
        reasoning: conversation.reasoning,
        permission: conversation.permission,
        turns: conversation.turns,
        steps: conversation.steps,
        usage: conversation.usage,
        last: conversation.last,
    }
}

export async function send(text: string, references: string[] = []): Promise<void> {
    const message = text.trim()
    if (message === "" || pendingSend) {
        return
    }
    if (store.ready !== true) {
        toast("界面尚未就绪", "error")
        return
    }
    /* 当前会话仍在跑：优先插话 */
    if (active !== null && !active.terminal && active.conversationId === store.activeId) {
        const accepted = await interject(message)
        if (accepted) {
            return
        }
        if (active !== null && !active.terminal) {
            toast("插话未送达", "error")
            return
        }
    }
    if (store.conversation === null) {
        await newConversation()
        if (store.conversation === null) {
            return
        }
    }
    const conversation = store.conversation
    if (store.running[conversation.id] === true) {
        toast("会话仍在运行，刷新页面续接", "error")
        return
    }
    pendingSend = true
    try {
        await beginTurn(conversation, { message, references })
    } finally {
        pendingSend = false
    }
}

export async function stop(): Promise<void> {
    const conversationId = store.activeId
    if (conversationId === null) {
        return
    }
    const stream = active !== null && active.conversationId === conversationId ? active : null
    try {
        await api.stop(conversationId)
    } catch (error) {
        toast(errorText(error), "error")
        return
    }
    if (stream !== null) {
        stream.stopRequested = true
        stream.stopTimer = window.setTimeout(() => {
            if (!stream.terminal) {
                void reconcile(stream)
            }
        }, STOP_FALLBACK_MS)
        return
    }
    store.running[conversationId] = false
    syncStreaming()
    void refreshConversations()
    if (store.conversation?.id === conversationId) {
        void refreshActiveConversation(conversationId)
    }
}

/** 重试：优先续接服务端活跃轮次，否则重发最后一条用户消息 */
export async function retry(): Promise<void> {
    const conversation = store.conversation
    if (conversation === null) {
        return
    }
    if (active !== null && !active.terminal) {
        if (active.handle !== null) {
            return
        }
        active.attempts = 0
        await attemptResume(active)
        return
    }
    if (store.running[conversation.id] === true) {
        await resumeRunning(conversation)
        return
    }
    for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
        const message = conversation.messages[index]
        if (message !== undefined && message.role === "user") {
            await send(message.text)
            return
        }
    }
}

export async function interject(text: string): Promise<boolean> {
    const conversationId = store.activeId
    if (conversationId === null || text.trim() === "") {
        return false
    }
    try {
        const result = await api.interject(conversationId, text.trim())
        if (result.accepted) {
            clearDraft(conversationId)
            return true
        }
        return false
    } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
            return false
        }
        toast(errorText(error), "error")
        return false
    }
}

export async function answerAsk(askId: string, answer: string): Promise<void> {
    const message = findBlockMessage("ask", askId)
    const block = message?.blocks.find(
        (item): item is Extract<Block, { type: "ask" }> => item.type === "ask" && item.askId === askId,
    )
    const previous = block?.answer ?? null
    if (block !== undefined) {
        block.answer = answer
    }
    try {
        const result = await api.answerAsk(askId, answer)
        if (result.stale) {
            toast("该提问已失效", "info")
        }
    } catch (error) {
        if (block !== undefined) {
            block.answer = previous
        }
        toast(errorText(error), "error")
    }
}

export async function answerApproval(approvalId: string, approved: boolean): Promise<void> {
    const message = findBlockMessage("approval", approvalId)
    const block = message?.blocks.find(
        (item): item is Extract<Block, { type: "approval" }> =>
            item.type === "approval" && item.approvalId === approvalId,
    )
    const previous = block?.approved ?? null
    if (block !== undefined) {
        block.approved = approved
    }
    try {
        const result = await api.answerApproval(approvalId, approved)
        if (result.stale) {
            toast("该审批已失效", "info")
        }
    } catch (error) {
        if (block !== undefined) {
            block.approved = previous
        }
        toast(errorText(error), "error")
    }
}

function findBlockMessage(type: "ask" | "approval", id: string): ChatMessage | null {
    if (store.conversation === null) {
        return null
    }
    for (let index = store.conversation.messages.length - 1; index >= 0; index -= 1) {
        const message = store.conversation.messages[index]
        if (message === undefined) {
            continue
        }
        const found = message.blocks.some((block) =>
            type === "ask"
                ? block.type === "ask" && block.askId === id
                : block.type === "approval" && block.approvalId === id,
        )
        if (found) {
            return message
        }
    }
    return null
}

export async function renameConversation(id: string, title: string): Promise<void> {
    const trimmed = title.trim()
    if (trimmed === "") {
        return
    }
    try {
        const { conversation } = await api.patchConversation(id, { title: trimmed })
        const summary = store.conversations.find((item) => item.id === id)
        if (summary !== undefined) {
            summary.title = conversation.title
            summary.updatedAt = conversation.updatedAt
        }
        if (store.conversation?.id === id) {
            store.conversation.title = conversation.title
        }
        sortConversations()
    } catch (error) {
        toast(errorText(error), "error")
    }
}

export async function deleteConversation(id: string): Promise<void> {
    try {
        await api.deleteConversation(id)
    } catch (error) {
        toast(errorText(error), "error")
        return
    }
    if (active?.conversationId === id) {
        detachStream(active)
        active = null
    }
    store.conversations = store.conversations.filter((item) => item.id !== id)
    delete store.running[id]
    delete store.drafts[id]
    persistDrafts()
    if (store.activeId !== id) {
        return
    }
    store.activeId = null
    store.conversation = null
    store.draft = ""
    syncStreaming()
    const next = store.conversations[0]
    if (next !== undefined) {
        await openConversation(next.id)
    }
}

/** 新会话默认权限（本地偏好） */
export function setDefaultPermission(permission: Permission): void {
    store.defaultPermission = permission
    try {
        localStorage.setItem(PERMISSION_KEY, permission)
    } catch {
        /* 存储不可用 */
    }
}

/** 刷新会话列表与当前会话 */
export async function refresh(): Promise<void> {
    await refreshConversations()
    if (store.activeId !== null && active === null) {
        await refreshActiveConversation(store.activeId)
    }
}

export async function setPermission(permission: Permission): Promise<void> {
    const conversation = store.conversation
    if (conversation === null) {
        store.defaultPermission = permission
        try {
            localStorage.setItem(PERMISSION_KEY, permission)
        } catch {
            /* 存储不可用 */
        }
        return
    }
    if (store.streaming) {
        toast("运行中无法切换权限", "error")
        return
    }
    const previous = conversation.permission
    conversation.permission = permission
    try {
        const result = await api.patchConversation(conversation.id, { permission })
        store.conversation = result.conversation
        syncSummary(result.conversation)
    } catch (error) {
        conversation.permission = previous
        toast(errorText(error), "error")
    }
}

export async function setModel(choice: {
    provider?: string
    model?: string
    reasoning?: string
}): Promise<void> {
    const conversation = store.conversation
    if (conversation !== null) {
        const previous = {
            provider: conversation.provider,
            model: conversation.model,
            reasoning: conversation.reasoning,
        }
        if (choice.provider !== undefined) {
            conversation.provider = choice.provider
        }
        if (choice.model !== undefined) {
            conversation.model = choice.model
        }
        if (choice.reasoning !== undefined) {
            conversation.reasoning = choice.reasoning
        }
        const body: {
            provider?: string
            model?: string
            reasoning?: string
        } = {}
        if (choice.provider !== undefined) {
            body.provider = choice.provider
        }
        if (choice.model !== undefined) {
            body.model = choice.model
        }
        if (choice.reasoning !== undefined) {
            body.reasoning = choice.reasoning
        }
        try {
            const result = await api.patchConversation(conversation.id, body)
            store.conversation = result.conversation
            syncSummary(result.conversation)
        } catch (error) {
            conversation.provider = previous.provider
            conversation.model = previous.model
            conversation.reasoning = previous.reasoning
            toast(errorText(error), "error")
        }
        return
    }
    await setActiveModel(choice)
}

/** 宿主全局默认模型（新会话沿用） */
export async function setActiveModel(choice: {
    provider?: string
    model?: string | null
    reasoning?: string | null
}): Promise<void> {
    const models = store.models
    if (models === null) {
        toast("模型信息不可用", "error")
        return
    }
    try {
        const result = await api.setActiveModel({
            providerId: choice.provider ?? models.activeProvider,
            model: choice.model !== undefined ? choice.model : models.activeModel,
            reasoning: choice.reasoning !== undefined ? choice.reasoning : models.activeReasoning,
        })
        store.models = result.models
    } catch (error) {
        toast(errorText(error), "error")
    }
}

export async function setWorkspace(id: string): Promise<void> {
    const workspace = store.workspaces.find((item) => item.id === id)
    if (workspace === undefined) {
        return
    }
    store.workspaceId = id
    try {
        localStorage.setItem(WORKSPACE_KEY, id)
    } catch {
        /* 存储不可用 */
    }
    const conversation = store.conversation
    if (conversation === null || conversation.workspaceId === id) {
        return
    }
    if (store.streaming) {
        toast("运行中无法切换工作区", "error")
        return
    }
    try {
        const result = await api.patchConversation(conversation.id, { workspaceId: id })
        store.conversation = result.conversation
        syncSummary(result.conversation)
    } catch (error) {
        toast(errorText(error), "error")
    }
}

export async function addWorkspace(input?: { pick?: boolean; root?: string }): Promise<void> {
    try {
        const result = await api.addWorkspace(input?.pick === true ? { pick: true } : { root: input?.root })
        store.workspaces = result.workspaces
        store.workspaceId = result.workspace.id
        try {
            localStorage.setItem(WORKSPACE_KEY, result.workspace.id)
        } catch {
            /* 存储不可用 */
        }
        toast("工作区已添加", "success")
    } catch (error) {
        toast(errorText(error), "error")
    }
}

export async function removeWorkspace(id: string): Promise<void> {
    try {
        const result = await api.removeWorkspace(id)
        store.workspaces = result.workspaces
        if (store.workspaceId === id) {
            const first = store.workspaces[0]
            store.workspaceId = first !== undefined ? first.id : null
            if (store.workspaceId !== null) {
                try {
                    localStorage.setItem(WORKSPACE_KEY, store.workspaceId)
                } catch {
                    /* 存储不可用 */
                }
            }
        }
        toast("工作区已移除", "success")
    } catch (error) {
        toast(errorText(error), "error")
    }
}

/** 当前会话的引用根目录 */
export function currentRoot(): string | null {
    const conversation = store.conversation
    if (conversation?.cwd !== null && conversation?.cwd !== undefined) {
        return conversation.cwd
    }
    const workspaceId = conversation?.workspaceId ?? store.workspaceId
    if (workspaceId !== null) {
        const workspace = store.workspaces.find((item) => item.id === workspaceId)
        if (workspace !== undefined) {
            return workspace.root
        }
    }
    const first = store.workspaces[0]
    if (first !== undefined) {
        return first.root
    }
    return store.host?.cwd ?? null
}

export async function searchFiles(query: string): Promise<WorkspaceFileEntry[]> {
    const root = currentRoot()
    if (root === null) {
        return []
    }
    try {
        const result = await api.files(root, query)
        return result.entries
    } catch {
        return []
    }
}

export async function openPath(path: string, mode: "default" | "reveal" = "default"): Promise<void> {
    try {
        await api.openPath(path, mode)
    } catch (error) {
        toast(errorText(error), "error")
    }
}

export function toggleSidebar(open?: boolean): void {
    store.sidebarOpen = open ?? !store.sidebarOpen
    if (store.sidebarOpen) {
        store.inspectorOpen = false
    }
}

export function toggleInspector(open?: boolean): void {
    store.inspectorOpen = open ?? !store.inspectorOpen
    if (store.inspectorOpen) {
        store.sidebarOpen = false
    }
    try {
        localStorage.setItem(INSPECTOR_KEY, store.inspectorOpen ? "open" : "closed")
    } catch {
        /* 存储不可用 */
    }
}

/** 视口跨过窄屏断点时同步抽屉：进入窄屏收起，离开时恢复默认（不改写用户偏好） */
export function syncLayoutWidth(narrow: boolean): void {
    store.sidebarOpen = false
    store.inspectorOpen = narrow ? false : initialInspectorOpen()
}

export function openSettings(open = true): void {
    store.settingsOpen = open
}

async function refreshActiveConversation(id: string): Promise<void> {
    try {
        const { conversation, running } = await api.getConversation(id)
        store.running[id] = running
        if (store.activeId === id) {
            store.conversation = conversation
        }
        syncSummary(conversation)
        syncStreaming()
    } catch {
        /* 刷新失败保持本地状态 */
    }
}

/* ------------------------------ 初始化 ------------------------------ */

export const actions = {
    bootstrap,
    refreshConversations,
    openConversation,
    newConversation,
    send,
    stop,
    retry,
    interject,
    answerAsk,
    answerApproval,
    renameConversation,
    deleteConversation,
    setPermission,
    setDefaultPermission,
    refresh,
    setModel,
    setActiveModel,
    setTheme,
    setWorkspace,
    addWorkspace,
    removeWorkspace,
    searchFiles,
    openPath,
    toggleSidebar,
    toggleInspector,
    syncLayoutWidth,
    openSettings,
    setDraft,
    toast,
}

function initialInspectorOpen(): boolean {
    try {
        const saved = localStorage.getItem(INSPECTOR_KEY)
        if (saved === "open") {
            return window.innerWidth > 1023
        }
        if (saved === "closed") {
            return false
        }
    } catch {
        /* 存储不可用 */
    }
    /* 宽屏默认展开三栏，窄屏不占位 */
    return window.innerWidth >= 1280
}

function init(): void {
    store.inspectorOpen = initialInspectorOpen()
    store.theme = loadThemePref()
    watchSystemTheme()
    applyTheme()
    try {
        const permission = localStorage.getItem(PERMISSION_KEY)
        if (permission === "read-only" || permission === "workspace-write" || permission === "danger-full-access") {
            store.defaultPermission = permission
        }
    } catch {
        /* 存储不可用 */
    }
    loadDrafts()
    bindLifecycle()
    pollRunning()
}

init()

/* ------------------------------ 内部类型守卫再导出 ------------------------------ */

export function isChatConversation(value: unknown): value is Conversation {
    if (!isRecord(value)) {
        return false
    }
    return typeof value["id"] === "string" && Array.isArray(value["messages"])
}

export function isReasoningLevel(value: string): value is ReasoningLevel {
    return value === "off" || value === "low" || value === "high" || value === "max"
}
