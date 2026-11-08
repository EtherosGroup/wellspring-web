/*
 * 会话持久化
 *
 * 数据根：插件数据目录（api.fs 根）下的 chat/
 *   chat/index.json              { v:1, activeId, conversations: Summary[] }
 *   chat/conversations/<id>.json StoredConversation
 *
 * 写入经单队列串行，先写会话文件再写索引
 * 读取时规范化，损坏或版本不认识的文件跳过并 warning，不影响其它会话
 */

import { DEFAULT_CHAT_LIMITS } from "./chat-types.ts"
import type {
    Block,
    ChatLimits,
    ChatPermission,
    ConversationIndex,
    ConversationSummary,
    LastMessagePreview,
    MessageStatus,
    StoredConversation,
    StoredMessage,
    Usage,
} from "./chat-types.ts"

/** 插件日志接口；pino logger 结构兼容 */
export interface ChatLogger {
    info?(data: unknown, message?: string): void
    warn?(data: unknown, message?: string): void
    error?(data: unknown, message?: string): void
}

/** 会话存储用到的宿主文件 API 子集；api.fs 结构兼容 */
export interface HostFileApiLike {
    readonly root?: string
    readJson<T = unknown>(path: string): Promise<T | null>
    writeJson(path: string, value: unknown): Promise<void>
    mkdir(path: string): Promise<void>
    list(path?: string): Promise<readonly HostFileEntryLike[]>
    remove(path: string): Promise<void>
    exists(path: string): Promise<boolean>
}

export interface HostFileEntryLike {
    readonly name: string
    readonly type: string
}

export const CHAT_DIR = "chat"
export const CHAT_INDEX_PATH = "chat/index.json"
export const CHAT_CONVERSATIONS_DIR = "chat/conversations"
export const DEFAULT_CHAT_TITLE = "新对话"
export const DEFAULT_CHAT_PERMISSION: ChatPermission = "read-only"
export const CONVERSATION_ID_PATTERN = /^c[a-z0-9]{8,20}$/

/** 会话 id 校验 */
export function isConversationId(value: unknown): value is string {
    return typeof value === "string" && CONVERSATION_ID_PATTERN.test(value)
}

export type ChatStoreErrorCode = "invalid" | "not-found"

export class ChatStoreError extends Error {
    readonly code: ChatStoreErrorCode

    constructor(code: ChatStoreErrorCode, message: string) {
        super(message)
        this.name = "ChatStoreError"
        this.code = code
    }
}

/** create 的入参；未给出的字段取默认值 */
export interface ChatCreateInput {
    readonly title?: string
    readonly cwd?: string | null
    readonly workspaceId?: string | null
    readonly permission?: ChatPermission
    readonly provider?: string | null
    readonly model?: string | null
    readonly reasoning?: string | null
}

/** mutate 回调拿到的可变会话副本 */
export interface ConversationDraft {
    v: 1
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
    permission: ChatPermission
    turns: number
    steps: number
    usage: Usage | null
    last: LastMessagePreview | null
    messages: StoredMessage[]
}

export interface ChatStoreOptions {
    readonly fs: HostFileApiLike
    readonly limits?: Partial<ChatLimits>
    readonly logger?: ChatLogger
    readonly now?: () => number
}

const MESSAGE_STATUSES: readonly MessageStatus[] = [
    "streaming",
    "done",
    "stopped",
    "error",
    "interrupted",
]

/** 列表摘要里的正文预览长度 */
const LAST_PREVIEW_CHARS = 200

/** 合并限额并过滤非法值 */
export function resolveChatLimits(limits?: Partial<ChatLimits>): ChatLimits {
    const result: { -readonly [K in keyof ChatLimits]: ChatLimits[K] } = {
        ...DEFAULT_CHAT_LIMITS,
    }
    if (limits !== undefined) {
        for (const key of Object.keys(DEFAULT_CHAT_LIMITS) as (keyof ChatLimits)[]) {
            const value = limits[key]
            if (typeof value === "number" && Number.isFinite(value) && value > 0) {
                result[key] = Math.floor(value)
            }
        }
    }
    return result
}

export class ChatStore {
    readonly limits: ChatLimits

    readonly #fs: HostFileApiLike
    readonly #logger: ChatLogger
    readonly #now: () => number

    #index: ConversationIndex = { v: 1, activeId: null, conversations: [] }
    #queue: Promise<unknown> = Promise.resolve()
    #loadPromise: Promise<void> | null = null

    constructor(options: ChatStoreOptions) {
        this.#fs = options.fs
        this.limits = resolveChatLimits(options.limits)
        this.#logger = options.logger ?? {}
        this.#now = options.now ?? Date.now
    }

    get activeId(): string | null {
        return this.#index.activeId
    }

    list(): readonly ConversationSummary[] {
        return this.#index.conversations
    }

    async load(): Promise<void> {
        if (this.#loadPromise === null) {
            this.#loadPromise = this.#load()
        }
        await this.#loadPromise
    }

    async get(id: string): Promise<StoredConversation | null> {
        if (!isConversationId(id)) {
            return null
        }
        await this.load()
        return await this.#enqueue(async () => await this.#readConversation(id, false))
    }

    async create(input: ChatCreateInput = {}): Promise<StoredConversation> {
        await this.load()
        return await this.#enqueue(async () => {
            const now = this.#now()
            const id = await this.#nextId()
            const conversation: StoredConversation = {
                v: 1,
                id,
                title: normalizeTitle(input.title),
                createdAt: now,
                updatedAt: now,
                sessionId: null,
                cwd: normalizeNullableText(input.cwd),
                workspaceId: normalizeNullableText(input.workspaceId),
                provider: normalizeNullableText(input.provider),
                model: normalizeNullableText(input.model),
                reasoning: normalizeNullableText(input.reasoning),
                permission: normalizePermission(input.permission),
                turns: 0,
                steps: 0,
                usage: null,
                last: null,
                messages: [],
            }
            await this.#commit(conversation)
            return conversation
        })
    }

    async mutate(
        id: string,
        fn: (draft: ConversationDraft) => void | Promise<void>,
    ): Promise<StoredConversation> {
        if (!isConversationId(id)) {
            throw new ChatStoreError("invalid", "会话 id 不合法")
        }
        await this.load()
        return await this.#enqueue(async () => {
            const current = await this.#readConversation(id, false)
            if (current === null) {
                throw new ChatStoreError("not-found", "会话不存在")
            }
            const draft = structuredClone(current) as unknown as ConversationDraft
            draft.messages = [...draft.messages]
            await fn(draft)
            const messages = trimMessages(
                normalizeMessages(draft.messages, this.limits, false),
                this.limits.maxConversationChars,
            )
            const conversation = buildConversation(
                {
                    id,
                    title: draft.title,
                    createdAt: current.createdAt,
                    updatedAt: Math.max(this.#now(), current.updatedAt + 1),
                    sessionId: normalizeNullableText(draft.sessionId),
                    cwd: normalizeNullableText(draft.cwd),
                    workspaceId: normalizeNullableText(draft.workspaceId),
                    provider: normalizeNullableText(draft.provider),
                    model: normalizeNullableText(draft.model),
                    reasoning: normalizeNullableText(draft.reasoning),
                    permission: normalizePermission(draft.permission),
                },
                messages,
                true,
            )
            await this.#commit(conversation)
            return conversation
        })
    }

    async remove(id: string): Promise<boolean> {
        if (!isConversationId(id)) {
            return false
        }
        await this.load()
        return await this.#enqueue(async () => {
            const exists = this.#index.conversations.some((item) => item.id === id)
            if (!exists) {
                return false
            }
            await this.#fs.remove(conversationPath(id))
            const remaining = this.#index.conversations.filter((item) => item.id !== id)
            this.#index = {
                v: 1,
                activeId: this.#index.activeId === id ? (remaining[0]?.id ?? null) : this.#index.activeId,
                conversations: remaining,
            }
            await this.#writeIndex()
            return true
        })
    }

    async setActive(id: string | null): Promise<string | null> {
        await this.load()
        return await this.#enqueue(async () => {
            let next: string | null = null
            if (id !== null) {
                next = this.#index.conversations.some((item) => item.id === id) ? id : this.#index.activeId
            }
            if (next !== this.#index.activeId) {
                this.#index = { ...this.#index, activeId: next }
                await this.#writeIndex()
            }
            return this.#index.activeId
        })
    }

    /* ------------------------------------------------------------------ */
    /* 内部：加载与索引                                                     */
    /* ------------------------------------------------------------------ */

    async #load(): Promise<void> {
        await this.#enqueue(async () => {
            await this.#ensureDir(CHAT_DIR)
            await this.#ensureDir(CHAT_CONVERSATIONS_DIR)

            const loaded = await this.#readIndex()
            let conversations = [...loaded.index.conversations]
            let activeId = loaded.index.activeId
            let changed = loaded.repaired
            const streamingIds = [...loaded.streamingIds]

            const files = await this.#listConversationFiles()
            if (files !== null) {
                const known = new Set(conversations.map((item) => item.id))
                const kept = conversations.filter((item) => files.has(item.id))
                if (kept.length !== conversations.length) {
                    changed = true
                    this.#warn({ dropped: conversations.length - kept.length }, "索引中的会话文件缺失")
                }
                for (const id of files) {
                    if (known.has(id)) {
                        continue
                    }
                    const conversation = await this.#readConversation(id, true)
                    if (conversation === null) {
                        continue
                    }
                    // 把崩溃遗留的 streaming 状态一并写回
                    await this.#fs.writeJson(conversationPath(id), conversation)
                    kept.push(summaryOf(conversation))
                    changed = true
                    this.#warn({ id }, "索引缺少会话记录，已恢复")
                }
                conversations = kept
            }

            // 上次进程中断时留下的 streaming 消息统一改为 interrupted
            if (streamingIds.length > 0) {
                const byId = new Map(conversations.map((item) => [item.id, item]))
                for (const id of streamingIds) {
                    const summary = byId.get(id)
                    if (summary === undefined) {
                        continue
                    }
                    const conversation = await this.#readConversation(id, true)
                    if (conversation === null) {
                        changed = true
                        byId.set(id, {
                            ...summary,
                            last: summary.last === null ? null : { ...summary.last, status: "interrupted" },
                        })
                        continue
                    }
                    await this.#fs.writeJson(conversationPath(id), conversation)
                    byId.set(id, summaryOf(conversation))
                    changed = true
                }
                conversations = [...byId.values()]
            }

            conversations.sort(compareSummaries)
            const capped: ConversationSummary[] = []
            const dropped: string[] = []
            for (const item of conversations) {
                if (capped.length < this.limits.maxConversations) {
                    capped.push(item)
                } else {
                    dropped.push(item.id)
                }
            }
            if (dropped.length > 0) {
                changed = true
                this.#warn({ dropped }, "会话数量超过上限，已丢弃最早会话")
            }
            if (activeId !== null && !capped.some((item) => item.id === activeId)) {
                activeId = capped[0]?.id ?? null
                changed = true
            }
            if (activeId === null && capped.length > 0) {
                activeId = capped[0]?.id ?? null
                changed = true
            }

            this.#index = { v: 1, activeId, conversations: capped }
            if (changed) {
                await this.#writeIndex()
            }
            for (const id of dropped) {
                await this.#removeFile(conversationPath(id))
            }
        })
    }

    /** 读索引；索引损坏时按空索引处理并标记需要重建 */
    async #readIndex(): Promise<{
        index: ConversationIndex
        streamingIds: readonly string[]
        repaired: boolean
    }> {
        const empty: ConversationIndex = { v: 1, activeId: null, conversations: [] }
        let raw: unknown
        try {
            raw = await this.#fs.readJson<unknown>(CHAT_INDEX_PATH)
        } catch (error) {
            this.#warn({ error: String(error) }, "会话索引读取失败")
            return { index: empty, streamingIds: [], repaired: true }
        }
        if (raw === null || raw === undefined) {
            return { index: empty, streamingIds: [], repaired: false }
        }
        const loaded = normalizeIndex(raw)
        if (loaded === null) {
            this.#warn({ path: CHAT_INDEX_PATH }, "会话索引格式不合法")
            return { index: empty, streamingIds: [], repaired: true }
        }
        return { index: loaded.index, streamingIds: loaded.streamingIds, repaired: false }
    }

    /** 列 conversations 目录下的会话文件名；目录不可读时返回 null */
    async #listConversationFiles(): Promise<Set<string> | null> {
        try {
            const entries = await this.#fs.list(CHAT_CONVERSATIONS_DIR)
            const ids = new Set<string>()
            for (const entry of entries) {
                if (entry.type !== "file" || !entry.name.endsWith(".json")) {
                    continue
                }
                const id = entry.name.slice(0, -".json".length)
                if (isConversationId(id)) {
                    ids.add(id)
                }
            }
            return ids
        } catch (error) {
            this.#warn({ error: String(error) }, "无法列出会话目录")
            return null
        }
    }

    async #writeIndex(): Promise<void> {
        const index: ConversationIndex = {
            v: 1,
            activeId: this.#index.activeId,
            conversations: this.#index.conversations,
        }
        await this.#fs.writeJson(CHAT_INDEX_PATH, index)
    }

    /* ------------------------------------------------------------------ */
    /* 内部：读写会话                                                       */
    /* ------------------------------------------------------------------ */

    async #readConversation(id: string, repairStreaming: boolean): Promise<StoredConversation | null> {
        let raw: unknown
        try {
            raw = await this.#fs.readJson<unknown>(conversationPath(id))
        } catch (error) {
            this.#warn({ id, error: String(error) }, "会话文件损坏，已跳过")
            return null
        }
        if (raw === null || raw === undefined) {
            return null
        }
        const conversation = normalizeStoredConversation(raw, id, this.limits, repairStreaming)
        if (conversation === null) {
            this.#warn({ id }, "会话文件格式不合法，已跳过")
            return null
        }
        return conversation
    }

    /** 写会话文件，再更新内存索引并写索引 */
    async #commit(conversation: StoredConversation): Promise<void> {
        await this.#fs.writeJson(conversationPath(conversation.id), conversation)
        let summaries = upsertSummary(this.#index.conversations, summaryOf(conversation))
        const dropped: string[] = []
        if (summaries.length > this.limits.maxConversations) {
            dropped.push(...summaries.slice(this.limits.maxConversations).map((item) => item.id))
            summaries = summaries.slice(0, this.limits.maxConversations)
        }
        let activeId = this.#index.activeId
        if (activeId !== null && dropped.includes(activeId)) {
            activeId = summaries[0]?.id ?? null
        }
        this.#index = { v: 1, activeId, conversations: summaries }
        await this.#writeIndex()
        for (const id of dropped) {
            await this.#removeFile(conversationPath(id))
        }
    }

    async #nextId(): Promise<string> {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const id = `c${randomBase36(12)}`
            if (this.#index.conversations.some((item) => item.id === id)) {
                continue
            }
            if (await this.#fs.exists(conversationPath(id))) {
                continue
            }
            return id
        }
        throw new ChatStoreError("invalid", "无法生成会话 id")
    }

    async #ensureDir(path: string): Promise<void> {
        try {
            await this.#fs.mkdir(path)
        } catch (error) {
            this.#warn({ path, error: String(error) }, "创建会话目录失败")
        }
    }

    async #removeFile(path: string): Promise<void> {
        try {
            await this.#fs.remove(path)
        } catch (error) {
            this.#warn({ path, error: String(error) }, "删除会话文件失败")
        }
    }

    #warn(data: unknown, message: string): void {
        this.#logger.warn?.(data, message)
    }

    /** 单写队列：所有写与读都按提交顺序串行 */
    #enqueue<T>(task: () => Promise<T>): Promise<T> {
        const run = this.#queue.then(() => task())
        this.#queue = run.then(
            () => undefined,
            () => undefined,
        )
        return run
    }
}

/* ---------------------------------------------------------------------- */
/* 规范化                                                                 */
/* ---------------------------------------------------------------------- */

interface ConversationFields {
    readonly id: string
    readonly title: unknown
    readonly createdAt: number
    readonly updatedAt: number
    readonly sessionId: unknown
    readonly cwd: unknown
    readonly workspaceId: unknown
    readonly provider: unknown
    readonly model: unknown
    readonly reasoning: unknown
    readonly permission: unknown
}

function buildConversation(
    fields: ConversationFields,
    messages: readonly StoredMessage[],
    deriveTitle: boolean,
): StoredConversation {
    const derived = deriveSummary(messages)
    const title = deriveTitle ? resolveTitle(fields.title, messages) : normalizeTitle(fields.title)
    return {
        v: 1,
        id: fields.id,
        title,
        createdAt: fields.createdAt,
        updatedAt: Math.max(fields.updatedAt, fields.createdAt),
        sessionId: normalizeNullableText(fields.sessionId),
        cwd: normalizeNullableText(fields.cwd),
        workspaceId: normalizeNullableText(fields.workspaceId),
        provider: normalizeNullableText(fields.provider),
        model: normalizeNullableText(fields.model),
        reasoning: normalizeNullableText(fields.reasoning),
        permission: normalizePermission(fields.permission),
        turns: derived.turns,
        steps: derived.steps,
        usage: derived.usage,
        last: derived.last,
        messages,
    }
}

function normalizeStoredConversation(
    value: unknown,
    expectedId: string,
    limits: ChatLimits,
    repairStreaming: boolean,
): StoredConversation | null {
    if (!isObject(value) || value.v !== 1) {
        return null
    }
    if (value.id !== expectedId || !isConversationId(value.id)) {
        return null
    }
    const createdAt = numberOr(value.createdAt, 0)
    const messages = trimMessages(
        normalizeMessages(value.messages, limits, repairStreaming),
        limits.maxConversationChars,
    )
    return buildConversation(
        {
            id: expectedId,
            title: value.title,
            createdAt,
            updatedAt: numberOr(value.updatedAt, createdAt),
            sessionId: value.sessionId,
            cwd: value.cwd,
            workspaceId: value.workspaceId,
            provider: value.provider,
            model: value.model,
            reasoning: value.reasoning,
            permission: value.permission,
        },
        messages,
        false,
    )
}

interface LoadedIndex {
    readonly index: ConversationIndex
    readonly streamingIds: readonly string[]
}

function normalizeIndex(value: unknown): LoadedIndex | null {
    if (!isObject(value) || value.v !== 1 || !Array.isArray(value.conversations)) {
        return null
    }
    const seen = new Set<string>()
    const conversations: ConversationSummary[] = []
    const streamingIds: string[] = []
    for (const item of value.conversations) {
        const summary = normalizeSummary(item)
        if (summary === null || seen.has(summary.id)) {
            continue
        }
        seen.add(summary.id)
        if (summary.last?.status === "streaming") {
            streamingIds.push(summary.id)
        }
        conversations.push(summary)
    }
    conversations.sort(compareSummaries)
    let activeId: string | null = null
    if (typeof value.activeId === "string" && seen.has(value.activeId)) {
        activeId = value.activeId
    } else {
        activeId = conversations[0]?.id ?? null
    }
    return { index: { v: 1, activeId, conversations }, streamingIds }
}

function normalizeSummary(value: unknown): ConversationSummary | null {
    if (!isObject(value) || !isConversationId(value.id)) {
        return null
    }
    const createdAt = numberOr(value.createdAt, 0)
    const last = normalizeLast(value.last)
    return {
        id: value.id,
        title: normalizeTitle(value.title),
        createdAt,
        updatedAt: numberOr(value.updatedAt, createdAt),
        sessionId: normalizeNullableText(value.sessionId),
        cwd: normalizeNullableText(value.cwd),
        workspaceId: normalizeNullableText(value.workspaceId),
        provider: normalizeNullableText(value.provider),
        model: normalizeNullableText(value.model),
        reasoning: normalizeNullableText(value.reasoning),
        permission: normalizePermission(value.permission),
        turns: nonNegativeInteger(value.turns),
        steps: nonNegativeInteger(value.steps),
        usage: normalizeUsage(value.usage),
        last,
    }
}

function normalizeLast(value: unknown): LastMessagePreview | null {
    if (!isObject(value) || (value.role !== "user" && value.role !== "assistant")) {
        return null
    }
    const text = stringOr(value.text, "").slice(0, LAST_PREVIEW_CHARS)
    const at = numberOr(value.at, 0)
    if (value.role === "user") {
        return { role: "user", text, at }
    }
    const status = normalizeStatus(value.status)
    return status === null ? { role: "assistant", text, at } : { role: "assistant", text, at, status }
}

function normalizeMessages(
    value: unknown,
    limits: ChatLimits,
    repairStreaming: boolean,
): StoredMessage[] {
    if (!Array.isArray(value)) {
        return []
    }
    const messages: StoredMessage[] = []
    for (const item of value) {
        const message = normalizeMessage(item, limits, repairStreaming)
        if (message !== null) {
            messages.push(message)
        }
    }
    return messages
}

function normalizeMessage(
    value: unknown,
    limits: ChatLimits,
    repairStreaming: boolean,
): StoredMessage | null {
    if (!isObject(value) || (value.role !== "user" && value.role !== "assistant")) {
        return null
    }
    const id = stringOr(value.id, "").trim()
    if (id === "" || id.length > 80) {
        return null
    }
    const at = numberOr(value.at, 0)
    const text = stringOr(value.text, "").slice(0, limits.maxMessageChars)
    const blocks = value.role === "user" ? [] : normalizeBlocks(value.blocks, limits)
    let status = normalizeStatus(value.status) ?? "done"
    if (repairStreaming && status === "streaming") {
        status = "interrupted"
    }
    const message: {
        -readonly [K in keyof StoredMessage]: StoredMessage[K]
    } = {
        id,
        role: value.role,
        at,
        text,
        blocks,
        status,
    }
    if (typeof value.error === "string" && value.error !== "") {
        message.error = value.error.slice(0, 2000)
    }
    const usage = normalizeUsage(value.usage)
    if (usage !== null) {
        message.usage = usage
    }
    const model = stringOr(value.model, "").trim()
    if (model !== "") {
        message.model = model.slice(0, 200)
    }
    const turn = nonNegativeIntegerOrNull(value.turn)
    if (turn !== null) {
        message.turn = turn
    }
    const steps = nonNegativeIntegerOrNull(value.steps)
    if (steps !== null) {
        message.steps = steps
    }
    const startedAt = numberOrNull(value.startedAt)
    if (startedAt !== null) {
        message.startedAt = startedAt
    }
    const endedAt = numberOrNull(value.endedAt)
    if (endedAt !== null) {
        message.endedAt = endedAt
    }
    return message as StoredMessage
}

function normalizeBlocks(value: unknown, limits: ChatLimits): Block[] {
    if (!Array.isArray(value)) {
        return []
    }
    const blocks: Block[] = []
    for (const item of value) {
        const block = normalizeBlock(item, limits)
        if (block !== null) {
            blocks.push(block)
        }
    }
    return blocks
}

function normalizeBlock(value: unknown, limits: ChatLimits): Block | null {
    if (!isObject(value)) {
        return null
    }
    const maxText = limits.maxConversationChars
    switch (value.type) {
        case "text": {
            return { type: "text", text: stringOr(value.text, "").slice(0, maxText) }
        }
        case "reasoning": {
            return {
                type: "reasoning",
                text: stringOr(value.text, "").slice(0, maxText),
                startedAt: numberOr(value.startedAt, 0),
                endedAt: numberOrNull(value.endedAt),
            }
        }
        case "tool": {
            const id = stringOr(value.id, "").trim()
            if (id === "") {
                return null
            }
            const phase = value.phase === "end" ? "end" : "start"
            return {
                type: "tool",
                id,
                name: stringOr(value.name, "").slice(0, 200),
                phase,
                ...optional("arguments", optionalString(value.arguments, maxText)),
                ...optional("ok", typeof value.ok === "boolean" ? value.ok : undefined),
                ...optional("result", optionalString(value.result, maxText)),
                ...optional("truncated", typeof value.truncated === "boolean" ? value.truncated : undefined),
                startedAt: numberOr(value.startedAt, 0),
                endedAt: numberOrNull(value.endedAt),
                status: value.status === "ok" || value.status === "error" ? value.status : "running",
            }
        }
        case "steer": {
            return {
                type: "steer",
                text: stringOr(value.text, "").slice(0, maxText),
                at: numberOr(value.at, 0),
            }
        }
        case "ask": {
            const askId = stringOr(value.askId, "").trim()
            if (askId === "") {
                return null
            }
            return {
                type: "ask",
                askId,
                question: stringOr(value.question, "").slice(0, maxText),
                options: stringArray(value.options, 10, 200),
                answer: typeof value.answer === "string" ? value.answer.slice(0, 8000) : null,
                at: numberOr(value.at, 0),
            }
        }
        case "approval": {
            const approvalId = stringOr(value.approvalId, "").trim()
            if (approvalId === "") {
                return null
            }
            return {
                type: "approval",
                approvalId,
                command: stringOr(value.command, "").slice(0, maxText),
                argv: stringArray(value.argv, 64, 512),
                cwd: stringOr(value.cwd, "").slice(0, 4096),
                ...optional("currentPermission", optionalString(value.currentPermission, 100)),
                ...optional("requestedPermission", optionalString(value.requestedPermission, 100)),
                ...optional("justification", optionalString(value.justification, maxText)),
                ...optional("network", typeof value.network === "boolean" ? value.network : undefined),
                ...optional("background", typeof value.background === "boolean" ? value.background : undefined),
                ...optional("stdin", optionalString(value.stdin, maxText)),
                ...optional("timeoutMs", numberOrNull(value.timeoutMs) ?? undefined),
                approved: typeof value.approved === "boolean" ? value.approved : null,
                at: numberOr(value.at, 0),
            }
        }
        case "note": {
            const tone = value.tone === "warn" ? "warn" : value.tone === "info" ? "info" : undefined
            return {
                type: "note",
                text: stringOr(value.text, "").slice(0, maxText),
                at: numberOr(value.at, 0),
                ...(tone === undefined ? {} : { tone }),
            }
        }
        default:
            return null
    }
}

function normalizeUsage(value: unknown): Usage | null {
    if (!isObject(value)) {
        return null
    }
    const usage: {
        -readonly [K in keyof Usage]: Usage[K]
    } = {
        inputTokens: numberOrNull(value.inputTokens),
        outputTokens: numberOrNull(value.outputTokens),
    }
    const cacheReadTokens = numberOrNull(value.cacheReadTokens)
    if (cacheReadTokens !== null) {
        usage.cacheReadTokens = cacheReadTokens
    }
    const cacheWriteTokens = numberOrNull(value.cacheWriteTokens)
    if (cacheWriteTokens !== null) {
        usage.cacheWriteTokens = cacheWriteTokens
    }
    const reasoningTokens = numberOrNull(value.reasoningTokens)
    if (reasoningTokens !== null) {
        usage.reasoningTokens = reasoningTokens
    }
    const contextTokens = numberOrNull(value.contextTokens)
    if (contextTokens !== null) {
        usage.contextTokens = contextTokens
    }
    return usage as Usage
}

function deriveSummary(messages: readonly StoredMessage[]): {
    readonly turns: number
    readonly steps: number
    readonly usage: Usage | null
    readonly last: LastMessagePreview | null
} {
    let usage: Usage | null = null
    let turns = 0
    let steps = 0
    for (const message of messages) {
        if (message.role === "user") {
            turns += 1
        } else {
            steps += message.steps ?? 0
        }
        if (message.usage !== undefined) {
            usage = message.usage
        }
    }
    const tail = messages[messages.length - 1]
    return { turns, steps, usage, last: tail === undefined ? null : previewOf(tail) }
}

function previewOf(message: StoredMessage): LastMessagePreview {
    const text = message.text !== "" ? message.text : textOfBlocks(message.blocks)
    const preview = text.slice(0, LAST_PREVIEW_CHARS)
    if (message.role === "user") {
        return { role: "user", text: preview, at: message.at }
    }
    return { role: "assistant", text: preview, at: message.at, status: message.status }
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

/** 单会话字符数（正文与过程块，正文块与 message.text 不重复计数） */
function messageChars(message: StoredMessage): number {
    let chars = message.text.length
    for (const block of message.blocks) {
        if (block.type === "text") {
            if (message.text === "") {
                chars += block.text.length
            }
        } else {
            chars += blockChars(block)
        }
    }
    return chars
}

function blockChars(block: Block): number {
    switch (block.type) {
        case "text":
            return block.text.length
        case "reasoning":
            return block.text.length
        case "tool":
            return (block.arguments?.length ?? 0) + (block.result?.length ?? 0) + block.name.length
        case "steer":
            return block.text.length
        case "ask":
            return block.question.length + (block.answer?.length ?? 0)
        case "approval":
            return block.command.length + block.argv.join(" ").length + (block.justification?.length ?? 0)
        case "note":
            return block.text.length
    }
}

/** 超限时丢弃最早消息，至少保留一条 */
function trimMessages(messages: readonly StoredMessage[], maxChars: number): StoredMessage[] {
    let total = 0
    for (const message of messages) {
        total += messageChars(message)
    }
    let start = 0
    while (total > maxChars && messages.length - start > 1) {
        const message = messages[start]
        if (message === undefined) {
            break
        }
        total -= messageChars(message)
        start += 1
    }
    return start === 0 ? [...messages] : messages.slice(start)
}

function summaryOf(conversation: StoredConversation): ConversationSummary {
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

function upsertSummary(
    summaries: readonly ConversationSummary[],
    summary: ConversationSummary,
): ConversationSummary[] {
    const next = summaries.filter((item) => item.id !== summary.id)
    next.push(summary)
    next.sort(compareSummaries)
    return next
}

function compareSummaries(left: ConversationSummary, right: ConversationSummary): number {
    if (left.updatedAt !== right.updatedAt) {
        return right.updatedAt - left.updatedAt
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/* ---------------------------------------------------------------------- */
/* 基础工具                                                               */
/* ---------------------------------------------------------------------- */

function conversationPath(id: string): string {
    return `${CHAT_CONVERSATIONS_DIR}/${id}.json`
}

function normalizeTitle(value: unknown): string {
    const text = stringOr(value, "")
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .trim()
    if (text === "") {
        return DEFAULT_CHAT_TITLE
    }
    return Array.from(text).slice(0, 80).join("")
}

/** 标题取首条用户消息首行，最多 32 字 */
function resolveTitle(rawTitle: unknown, messages: readonly StoredMessage[]): string {
    const configured = typeof rawTitle === "string" ? rawTitle.trim() : ""
    const normalized = normalizeTitle(rawTitle)
    if (configured === "" || normalized === DEFAULT_CHAT_TITLE) {
        const firstUser = messages.find((message) => message.role === "user")
        if (firstUser !== undefined) {
            const line = firstUser.text.split(/\r?\n/, 1)[0]?.trim() ?? ""
            const chars = Array.from(line)
            if (chars.length > 0) {
                return chars.length > 32 ? `${chars.slice(0, 32).join("")}…` : chars.join("")
            }
        }
    }
    return normalized
}

function normalizePermission(value: unknown): ChatPermission {
    return value === "workspace-write" || value === "danger-full-access" || value === "read-only"
        ? value
        : DEFAULT_CHAT_PERMISSION
}

function normalizeStatus(value: unknown): MessageStatus | null {
    return typeof value === "string" && (MESSAGE_STATUSES as readonly string[]).includes(value)
        ? (value as MessageStatus)
        : null
}

function normalizeNullableText(value: unknown): string | null {
    if (typeof value !== "string") {
        return null
    }
    const text = value.trim()
    return text === "" ? null : text.slice(0, 4096)
}

function stringOr(value: unknown, fallback: string): string {
    return typeof value === "string" ? value : fallback
}

function optionalString(value: unknown, max: number): string | undefined {
    if (typeof value !== "string") {
        return undefined
    }
    return value.slice(0, max)
}

function numberOr(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function numberOrNull(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null
}

function nonNegativeInteger(value: unknown): number {
    const number = numberOr(value, 0)
    return number > 0 ? Math.floor(number) : 0
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
    const number = numberOrNull(value)
    return number === null || number < 0 ? null : Math.floor(number)
}

function stringArray(value: unknown, maxItems: number, maxChars: number): string[] {
    if (!Array.isArray(value)) {
        return []
    }
    const result: string[] = []
    for (const item of value) {
        if (typeof item !== "string") {
            continue
        }
        result.push(item.slice(0, maxChars))
        if (result.length >= maxItems) {
            break
        }
    }
    return result
}

/** 值为 undefined 时省略该可选字段 */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
    return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V })
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function randomBase36(length: number): string {
    let result = ""
    while (result.length < length) {
        result += Math.random().toString(36).slice(2)
    }
    return result.slice(0, length)
}
