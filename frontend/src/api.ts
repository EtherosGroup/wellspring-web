/*
 * 同源 HTTP 客户端与 SSE 解析
 *
 * - 所有写请求带 x-web-request 头（跨站请求会触发预检，被浏览器拦下）
 * - 流式对话用 fetch + ReadableStream 手动解析 SSE（EventSource 不能 POST）
 * - 只负责传输；重连/续接策略在 store.ts
 */

import type {
    BootstrapResponse,
    ChatEvent,
    Conversation,
    ConversationSummary,
    ModelsState,
    Permission,
    Workspace,
    WorkspaceCheck,
    WorkspaceFilesResult,
} from "./types"

export class ApiError extends Error {
    readonly status: number
    readonly code?: string

    constructor(message: string, status = 0, code?: string) {
        super(message)
        this.name = "ApiError"
        this.status = status
        this.code = code
    }
}

interface RequestOptions {
    method?: "GET" | "POST" | "PATCH" | "DELETE"
    body?: unknown
    signal?: AbortSignal
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    /* 相对路径：页面在网关 /web/ 下时也能请求到插件 */
    const target = path.startsWith("/") ? path.slice(1) : path
    const headers: Record<string, string> = { accept: "application/json" }
    const init: RequestInit = {
        method: options.method ?? "GET",
        credentials: "same-origin",
        headers,
    }
    if (options.body !== undefined) {
        headers["content-type"] = "application/json"
        ;(init as { body?: string }).body = JSON.stringify(options.body)
    }
    if (init.method !== "GET") {
        headers["x-web-request"] = "1"
    }
    if (options.signal !== undefined) {
        init.signal = options.signal
    }
    let response: Response
    try {
        response = await fetch(target, init)
    } catch (error) {
        throw new ApiError(error instanceof Error ? error.message : "网络请求失败")
    }
    if (response.status === 401) {
        /* 会话过期：交给浏览器重新走网关登录 */
        throw new ApiError("登录状态已失效，请刷新页面重新登录", 401)
    }
    const text = await response.text()
    let payload: unknown = null
    if (text !== "") {
        try {
            payload = JSON.parse(text)
        } catch {
            payload = null
        }
    }
    if (!response.ok) {
        const record = payload as { error?: unknown; code?: unknown } | null
        const message =
            typeof record?.error === "string" && record.error !== ""
                ? record.error
                : `请求失败（HTTP ${response.status}）`
        const code = typeof record?.code === "string" ? record.code : undefined
        throw new ApiError(message, response.status, code)
    }
    return payload as T
}

/* ------------------------------ 普通接口 ------------------------------ */

export const api = {
    bootstrap: (): Promise<BootstrapResponse> => request("/api/bootstrap"),
    conversations: (): Promise<{ conversations: ConversationSummary[]; activeId: string | null }> =>
        request("/api/conversations"),
    createConversation: (body: {
        cwd?: string
        workspaceId?: string
        title?: string
        permission?: Permission
        provider?: string
        model?: string
        reasoning?: string
    }): Promise<{ conversation: Conversation }> =>
        request("/api/conversations", { method: "POST", body }),
    getConversation: (id: string): Promise<{ conversation: Conversation; running: boolean }> =>
        request(`api/conversations/${encodeURIComponent(id)}`),
    patchConversation: (
        id: string,
        body: {
            title?: string
            cwd?: string
            workspaceId?: string
            permission?: Permission
            provider?: string
            model?: string
            reasoning?: string
        },
    ): Promise<{ conversation: Conversation }> =>
        request(`api/conversations/${encodeURIComponent(id)}`, { method: "PATCH", body }),
    deleteConversation: (id: string): Promise<{ ok: boolean }> =>
        request(`api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),
    setActiveConversation: (id: string): Promise<{ ok: boolean; activeId: string | null }> =>
        request(`api/conversations/${encodeURIComponent(id)}/active`, { method: "POST", body: {} }),
    running: (): Promise<{ running: { conversationId: string }[] }> => request("/api/running"),
    models: (): Promise<{ models: ModelsState | null }> => request("/api/models"),
    setActiveModel: (body: {
        providerId: string
        model: string | null
        reasoning?: string | null
    }): Promise<{ models: ModelsState }> => request("/api/models/active", { method: "POST", body }),
    workspaces: (): Promise<{ workspaces: Workspace[] }> => request("/api/workspaces"),
    addWorkspace: (body: { root?: string; name?: string; pick?: boolean }): Promise<{
        workspace: Workspace
        workspaces: Workspace[]
    }> => request("/api/workspaces", { method: "POST", body }),
    removeWorkspace: (id: string): Promise<{ ok: boolean; workspaces: Workspace[] }> =>
        request(`api/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" }),
    validateWorkspace: (root: string): Promise<WorkspaceCheck> =>
        request("/api/workspaces/validate", { method: "POST", body: { root } }),
    files: (root: string, query: string): Promise<WorkspaceFilesResult> =>
        request(`api/files?root=${encodeURIComponent(root)}&q=${encodeURIComponent(query)}`),
    openPath: (path: string, mode: "default" | "reveal" = "default"): Promise<{ ok: boolean }> =>
        request("/api/files/open", { method: "POST", body: { path, mode } }),
    stop: (conversationId: string): Promise<{ ok: boolean; stopped: boolean }> =>
        request(`api/conversations/${encodeURIComponent(conversationId)}/stop`, {
            method: "POST",
            body: {},
        }),
    interject: (conversationId: string, message: string): Promise<{ ok: boolean; accepted: boolean }> =>
        request(`api/conversations/${encodeURIComponent(conversationId)}/interject`, {
            method: "POST",
            body: { message },
        }),
    answerAsk: (askId: string, answer: string): Promise<{ ok: boolean; accepted: boolean; stale: boolean }> =>
        request(`api/asks/${encodeURIComponent(askId)}`, { method: "POST", body: { answer } }),
    answerApproval: (
        approvalId: string,
        approved: boolean,
    ): Promise<{ ok: boolean; accepted: boolean; stale: boolean }> =>
        request(`api/approvals/${encodeURIComponent(approvalId)}`, {
            method: "POST",
            body: { approved },
        }),
}

/* ------------------------------ SSE 客户端 ------------------------------ */

export interface ChatStreamHandlers {
    /** 每解析出一个数据事件调用一次；index 为该流内数据事件计数（从 1 开始） */
    onEvent: (event: ChatEvent, index: number) => void
    /** 流正常关闭（含服务端 end） */
    onClose: () => void
    /** 网络层中断（不是主动 abort） */
    onNetworkError: (error: unknown) => void
    /** 收到注释行（`: ping`），用于看门狗判定连接存活 */
    onComment?: () => void
}

export interface StreamHandle {
    /** 已收到的数据事件数量 */
    readonly received: number
    readonly closed: boolean
    /** 客户端主动断开（不影响服务端轮次） */
    abort: () => void
}

interface FrameParser {
    push: (text: string) => void
    flush: () => void
}

function createFrameParser(handlers: ChatStreamHandlers, state: { received: number }): FrameParser {
    let buffer = ""
    const handleFrame = (frame: string): void => {
        const data: string[] = []
        for (const rawLine of frame.split("\n")) {
            const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
            if (line === "") {
                continue
            }
            if (line.startsWith(":")) {
                handlers.onComment?.()
                continue
            }
            if (line.startsWith("data:")) {
                data.push(line.slice(5).replace(/^ /, ""))
            }
        }
        if (data.length === 0) {
            return
        }
        let parsed: ChatEvent
        try {
            parsed = JSON.parse(data.join("\n")) as ChatEvent
        } catch {
            return
        }
        state.received += 1
        handlers.onEvent(parsed, state.received)
    }
    return {
        push(text: string): void {
            buffer += text
            let index = buffer.indexOf("\n\n")
            while (index >= 0) {
                const frame = buffer.slice(0, index)
                buffer = buffer.slice(index + 2)
                handleFrame(frame)
                index = buffer.indexOf("\n\n")
            }
        },
        flush(): void {
            if (buffer.trim() !== "") {
                handleFrame(buffer)
            }
            buffer = ""
        },
    }
}

async function consumeSse(
    response: Response,
    handlers: ChatStreamHandlers,
    controller: AbortController,
    state: { received: number },
): Promise<void> {
    const body = response.body
    if (body === null) {
        handlers.onNetworkError(new ApiError("响应流不可读"))
        handlers.onClose()
        return
    }
    const reader = body.getReader()
    const decoder = new TextDecoder()
    const parser = createFrameParser(handlers, state)
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) {
                break
            }
            parser.push(decoder.decode(value, { stream: true }))
        }
        parser.flush()
        handlers.onClose()
    } catch (error) {
        if (controller.signal.aborted) {
            handlers.onClose()
            return
        }
        handlers.onNetworkError(error)
    }
}

function createHandle(controller: AbortController, state: { received: number; closed: boolean }): StreamHandle {
    return {
        get received() {
            return state.received
        },
        get closed() {
            return state.closed
        },
        abort() {
            state.closed = true
            controller.abort()
        },
    }
}

/** POST 发起一轮对话，返回可中止的流句柄 */
export async function openChatStream(
    conversationId: string,
    body: { message: string; references?: string[]; permission?: Permission },
    handlers: ChatStreamHandlers,
): Promise<StreamHandle> {
    const controller = new AbortController()
    const state = { received: 0, closed: false }
    const response = await fetch(`api/conversations/${encodeURIComponent(conversationId)}/chat`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
            "x-web-request": "1",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
    })
    if (!response.ok) {
        state.closed = true
        const text = await response.text()
        let message = `发起对话失败（HTTP ${response.status}）`
        let code: string | undefined
        try {
            const payload = JSON.parse(text) as { error?: unknown; code?: unknown }
            if (typeof payload.error === "string") {
                message = payload.error
            }
            if (typeof payload.code === "string") {
                code = payload.code
            }
        } catch {
            /* 非 JSON 错误页 */
        }
        throw new ApiError(message, response.status, code)
    }
    void consumeSse(response, handlers, controller, state).finally(() => {
        state.closed = true
    })
    return createHandle(controller, state)
}

export interface ResumeJsonResult {
    ok: false
    active: false
    error: string
}

export interface ResumePeek {
    ok: true
    active: boolean
    total: number
    done: boolean
    truncated: boolean
}

export interface ResumeStreamResult {
    kind: "stream"
    handle: StreamHandle
}

/** 续接 / 重放进行中的轮次；没有可续接内容时返回 JSON 结果 */
export async function openResumeStream(
    conversationId: string,
    since: number,
    handlers: ChatStreamHandlers,
): Promise<ResumeStreamResult | ResumeJsonResult> {
    const controller = new AbortController()
    const state = { received: 0, closed: false }
    const response = await fetch(
        `api/conversations/${encodeURIComponent(conversationId)}/resume?since=${Math.max(0, Math.floor(since))}`,
        {
            credentials: "same-origin",
            headers: { accept: "text/event-stream", "x-web-request": "1" },
            signal: controller.signal,
        },
    )
    if (!response.ok) {
        state.closed = true
        throw new ApiError(`续接失败（HTTP ${response.status}）`, response.status)
    }
    const contentType = response.headers.get("content-type") ?? ""
    if (!contentType.includes("text/event-stream")) {
        const payload = (await response.json()) as ResumeJsonResult
        return payload
    }
    void consumeSse(response, handlers, controller, state).finally(() => {
        state.closed = true
    })
    return { kind: "stream", handle: createHandle(controller, state) }
}

/** 轻量探测：服务端是否还有可续接的事件 */
export async function peekResume(conversationId: string): Promise<ResumePeek | ResumeJsonResult> {
    const response = await fetch(
        `api/conversations/${encodeURIComponent(conversationId)}/resume?peek=1`,
        { credentials: "same-origin", headers: { accept: "application/json" } },
    )
    if (!response.ok) {
        throw new ApiError(`探测失败（HTTP ${response.status}）`, response.status)
    }
    return (await response.json()) as ResumePeek | ResumeJsonResult
}
