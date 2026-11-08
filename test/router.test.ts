import assert from "node:assert/strict"
import { test } from "node:test"

import type {
    HostModelsState,
    HostWorkspaceCheck,
    HostWorkspaceEntry,
    HostWorkspaceFilesResult,
    HttpRequest,
    HttpStreamContext,
    HttpResponse,
    PluginApi,
} from "wellspring/api/host/index.ts"

import type { ChatRuntimeLike, ChatStoreLike } from "../src/api/context.ts"
import { ChatStoreError, type ConversationDraft } from "../src/chat-store.ts"
import type { ChatTurnInfo } from "../src/chat-runtime.ts"
import {
    DEFAULT_CHAT_LIMITS,
    type ChatRequest,
    type StoredConversation,
} from "../src/chat-types.ts"
import type { ConversationSummary } from "../src/chat-types.ts"
import { DEFAULT_WEB_CONFIG, type WebConfig } from "../src/config.ts"
import { createRouter, type WebRouterOptions } from "../src/router.ts"
import { MemoryFs } from "./helpers/memory-fs.ts"

/* ------------------------------ 测试夹具 ------------------------------ */

const ROOT = "/srv/www"

const staticFs = new MemoryFs({
    [`${ROOT}/index.html`]: '<!doctype html><html data-theme="{{theme}}"><h1>app</h1></html>',
    [`${ROOT}/assets/app-ABCD1234.js`]: "console.log(1)",
})

const config: WebConfig = {
    ...DEFAULT_WEB_CONFIG,
    limits: { ...DEFAULT_CHAT_LIMITS, maxMessageChars: 20, maxReferences: 2, maxBodyBytes: 4_096 },
}

function makeConversation(id: string, input: Record<string, unknown> = {}): StoredConversation {
    const now = 1_000
    return {
        v: 1,
        id,
        title: typeof input["title"] === "string" ? input["title"] : "新对话",
        createdAt: now,
        updatedAt: now,
        sessionId: null,
        cwd: typeof input["cwd"] === "string" ? input["cwd"] : null,
        workspaceId: typeof input["workspaceId"] === "string" ? input["workspaceId"] : null,
        provider: null,
        model: null,
        reasoning: null,
        permission: "read-only",
        turns: 0,
        steps: 0,
        usage: null,
        last: null,
        messages: [],
    }
}

function summaryOf(conversation: StoredConversation): ConversationSummary {
    const { v: _v, messages: _messages, ...summary } = conversation
    return summary
}

class FakeStore implements ChatStoreLike {
    readonly conversations = new Map<string, StoredConversation>()
    active: string | null = null
    loadCalls = 0

    async load(): Promise<void> {
        this.loadCalls += 1
    }

    get activeId(): string | null {
        return this.active
    }

    list(): readonly ConversationSummary[] {
        return [...this.conversations.values()].map(summaryOf)
    }

    async get(id: string): Promise<StoredConversation | null> {
        return this.conversations.get(id) ?? null
    }

    async create(input?: {
        title?: string
        cwd?: string | null
        workspaceId?: string | null
        permission?: string
    }): Promise<StoredConversation> {
        const id = `c${String(this.conversations.size + 1).padStart(12, "0")}`
        const conversation = makeConversation(id, input ?? {})
        this.conversations.set(id, conversation)
        return conversation
    }

    async mutate(
        id: string,
        fn: (draft: ConversationDraft) => void | Promise<void>,
    ): Promise<StoredConversation> {
        const current = this.conversations.get(id)
        if (current === undefined) {
            throw new ChatStoreError("not-found", "会话不存在")
        }
        const draft = structuredClone(current) as unknown as ConversationDraft
        draft.messages = [...draft.messages]
        await fn(draft)
        const updated: StoredConversation = {
            ...structuredClone(current),
            title: draft.title,
            updatedAt: current.updatedAt + 1,
            cwd: draft.cwd,
            workspaceId: draft.workspaceId,
            permission: draft.permission,
            provider: draft.provider,
            model: draft.model,
            reasoning: draft.reasoning,
        }
        this.conversations.set(id, updated)
        return updated
    }

    async remove(id: string): Promise<boolean> {
        return this.conversations.delete(id)
    }

    async setActive(id: string | null): Promise<string | null> {
        if (id !== null && this.conversations.has(id)) {
            this.active = id
        }
        return this.active
    }
}

interface RuntimeState {
    active: Set<string>
    peek: ChatTurnInfo | null
    startThrows: boolean
    stopResult: boolean
    interjectResult: boolean
    askResult: boolean
    approvalResult: boolean
    lastChat: { id: string; request: ChatRequest } | null
    lastResume: { id: string; since: number } | null
    lastInterject: { id: string; message: string } | null
    stopped: string[]
    doneChunksEnded: number
}

class FakeRuntime implements ChatRuntimeLike {
    readonly state: RuntimeState = {
        active: new Set(),
        peek: null,
        startThrows: false,
        stopResult: false,
        interjectResult: true,
        askResult: true,
        approvalResult: true,
        lastChat: null,
        lastResume: null,
        lastInterject: null,
        stopped: [],
        doneChunksEnded: 0,
    }

    running(): string[] {
        return [...this.state.active]
    }

    isRunning(conversationId: string): boolean {
        return this.state.active.has(conversationId)
    }

    async startTurn(
        conversationId: string,
        request: ChatRequest,
        stream: HttpStreamContext,
    ): Promise<void> {
        if (this.state.startThrows) {
            throw new Error("模拟启动失败")
        }
        this.state.lastChat = { id: conversationId, request }
        stream.write(
            `data: ${JSON.stringify({
                type: "accepted",
                conversationId,
                userMessageId: "u1",
                assistantMessageId: "a1",
                at: 1,
            })}\n\n`,
        )
        stream.write(`data: ${JSON.stringify({ type: "delta", text: request.message })}\n\n`)
        stream.write(`data: ${JSON.stringify({ type: "done", sessionId: "s1", turn: 1, steps: 1, reply: "ok", model: "m", usage: null })}\n\n`)
        stream.end()
        this.state.doneChunksEnded += 1
    }

    async resume(conversationId: string, since: number, stream: HttpStreamContext): Promise<void> {
        this.state.lastResume = { id: conversationId, since }
        stream.write(
            `data: ${JSON.stringify({ type: "resume", active: false, from: since, total: since })}\n\n`,
        )
        stream.end()
    }

    peek(conversationId: string): ChatTurnInfo | null {
        void conversationId
        return this.state.peek
    }

    async stop(conversationId: string): Promise<boolean> {
        this.state.stopped.push(conversationId)
        return this.state.stopResult
    }

    async interject(conversationId: string, message: string): Promise<boolean> {
        this.state.lastInterject = { id: conversationId, message }
        return this.state.interjectResult
    }

    async respondAsk(askId: string, answer: string): Promise<boolean> {
        void askId
        void answer
        return this.state.askResult
    }

    async respondApproval(approvalId: string, approved: boolean): Promise<boolean> {
        void approvalId
        void approved
        return this.state.approvalResult
    }
}

const modelsState: HostModelsState = {
    providers: [],
    activeProvider: "openai",
    activeModel: "gpt-4o",
    activeReasoning: "off",
    reasoningLevels: ["off", "low", "high", "max"],
}

const workspace: HostWorkspaceEntry = {
    id: "ws1",
    name: "项目",
    root: "/tmp/project",
    createdAt: 1,
    lastSeenAt: 2,
}

interface ApiCalls {
    setActive: unknown[]
    added: unknown[]
    removed: string[]
    opened: unknown[]
    validated: string[]
    workspaceChecks: Map<string, HostWorkspaceCheck | Error>
    workspaceListError: Error | null
}

function fakeApi(calls: ApiCalls): PluginApi {
    const api = {
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        models: {
            state: async () => modelsState,
            setActive: async (providerId: string, model: string | null, reasoning?: string | null) => {
                calls.setActive.push({ providerId, model, reasoning })
                return modelsState
            },
        },
        workspaces: {
            list: async () => {
                if (calls.workspaceListError !== null) {
                    throw calls.workspaceListError
                }
                return { workspaces: [workspace] }
            },
            add: async (input: { root: string; name?: string }) => {
                calls.added.push(input)
                return { workspace: { ...workspace, root: input.root }, duplicate: false }
            },
            remove: async (id: string) => {
                calls.removed.push(id)
                return { removed: true }
            },
            rename: async () => null,
            touch: async () => null,
        },
        agent: {
            validateWorkspace: async (root: string): Promise<HostWorkspaceCheck> => {
                calls.validated.push(root)
                const override = calls.workspaceChecks.get(root)
                if (override instanceof Error) {
                    throw override
                }
                if (override !== undefined) {
                    return override
                }
                return { ok: true, root, name: "project" }
            },
            pickDirectory: async (): Promise<HostWorkspaceCheck> => ({
                ok: true,
                root: "/tmp/picked",
                name: "picked",
            }),
            searchWorkspaceFiles: async (root: string, query: string): Promise<HostWorkspaceFilesResult> => ({
                ok: true,
                root,
                entries: [{ path: `${query}.txt`, name: "a.txt", type: "file" }],
                truncated: false,
            }),
            openPath: async (path: string, mode?: string) => {
                calls.opened.push({ path, mode })
            },
        },
    }
    return api as unknown as PluginApi
}

interface Harness {
    readonly router: (request: HttpRequest, stream: HttpStreamContext) => Promise<HttpResponse>
    readonly store: FakeStore
    readonly runtime: FakeRuntime
    readonly calls: ApiCalls
}

function harness(): Harness {
    const store = new FakeStore()
    const runtime = new FakeRuntime()
    const calls: ApiCalls = {
        setActive: [],
        added: [],
        removed: [],
        opened: [],
        validated: [],
        workspaceChecks: new Map(),
        workspaceListError: null,
    }
    const options: WebRouterOptions = {
        api: fakeApi(calls),
        config,
        store,
        runtime,
        version: "0.4.0",
        staticFs,
        wwwRoot: ROOT,
        hostInfo: () => ({
            status: "running",
            platform: "linux",
            arch: "x64",
            node: "v26.0.0",
            cwd: "/tmp/work",
        }),
    }
    return { router: createRouter(options), store, runtime, calls }
}

interface Captured {
    readonly stream: HttpStreamContext
    readonly chunks: string[]
    readonly isEnded: () => boolean
}

function capture(): Captured {
    const chunks: string[] = []
    let ended = false
    return {
        stream: {
            write: (chunk: string) => {
                chunks.push(chunk)
            },
            end: () => {
                ended = true
            },
        },
        chunks,
        isEnded: () => ended,
    }
}

function request(
    method: string,
    url: string,
    options: { headers?: Record<string, string>; body?: unknown; rawBody?: string } = {},
): HttpRequest {
    let body = ""
    if (options.rawBody !== undefined) {
        body = Buffer.from(options.rawBody).toString("base64")
    } else if (options.body !== undefined) {
        body = Buffer.from(JSON.stringify(options.body)).toString("base64")
    }
    return {
        method,
        url,
        headers: { host: "127.0.0.1:8787", ...options.headers },
        body,
        remoteAddress: null,
    }
}

function writeRequest(method: string, url: string, body?: unknown): HttpRequest {
    return request(method, url, {
        headers: { "x-web-request": "1", "content-type": "application/json" },
        ...(body === undefined ? {} : { body }),
    })
}

function payloadOf(response: HttpResponse): Record<string, unknown> {
    return JSON.parse(String(response.body)) as Record<string, unknown>
}

function chunksOf(captured: Captured): Record<string, unknown>[] {
    return captured.chunks.map((chunk) => {
        assert.ok(chunk.startsWith("data: "), chunk)
        return JSON.parse(chunk.slice(6).trimEnd()) as Record<string, unknown>
    })
}

/* ------------------------------ 静态资源 ------------------------------ */

test("静态：根路径下发 index.html 并注入主题", async () => {
    const { router } = harness()
    const captured = capture()
    const response = await router(
        request("GET", "/", { headers: { cookie: "wellspring_web_theme=dark" } }),
        captured.stream,
    )
    assert.equal(response.status, 200)
    assert.match(String(response.headers?.["content-type"]), /text\/html/)
    assert.match(String(response.body), /data-theme="dark"/)
    assert.match(String(response.headers?.["content-security-policy"]), /default-src 'none'/)
    assert.equal(response.headers?.["x-content-type-options"], "nosniff")
})

test("静态：SPA 回退与 404", async () => {
    const { router } = harness()
    const html = await router(
        request("GET", "/c/abc", { headers: { accept: "text/html" } }),
        capture().stream,
    )
    assert.equal(html.status, 200)
    assert.match(String(html.body), /<h1>app<\/h1>/)
    const missing = await router(
        request("GET", "/c/abc", { headers: { accept: "application/json" } }),
        capture().stream,
    )
    assert.equal(missing.status, 404)
    assert.match(String(missing.headers?.["content-type"]), /text\/plain/)
})

/* ------------------------------ 状态与模型 ------------------------------ */

test("GET /api/bootstrap：版本、用户、宿主、模型、会话、限额", async () => {
    const { router, store } = harness()
    store.conversations.set("cabcdef12345", makeConversation("cabcdef12345"))
    store.active = "cabcdef12345"
    const response = await router(
        request("GET", "/api/bootstrap", { headers: { "x-wellspring-user": "alice" } }),
        capture().stream,
    )
    assert.equal(response.status, 200)
    const body = payloadOf(response)
    assert.equal(body["version"], "0.4.0")
    assert.equal(body["user"], "alice")
    assert.deepEqual(body["host"], {
        status: "running",
        platform: "linux",
        arch: "x64",
        node: "v26.0.0",
        cwd: "/tmp/work",
    })
    assert.deepEqual((body["models"] as HostModelsState).activeProvider, "openai")
    assert.equal(body["activeId"], "cabcdef12345")
    assert.deepEqual(body["running"], [])
    assert.equal((body["conversations"] as unknown[]).length, 1)
    assert.equal((body["limits"] as Record<string, unknown>)["maxMessageChars"], 20)
    assert.equal((body["workspaces"] as unknown[]).length, 1)
    assert.equal(response.headers?.["content-type"], "application/json; charset=utf-8")
    assert.equal(response.headers?.["cache-control"], "no-store")
})

test("GET /api/models 与 POST /api/models/active", async () => {
    const { router, calls } = harness()
    const models = await router(request("GET", "/api/models"), capture().stream)
    assert.equal(models.status, 200)
    assert.equal((payloadOf(models)["models"] as HostModelsState).activeModel, "gpt-4o")

    const withoutHeader = await router(
        request("POST", "/api/models/active", {
            headers: { "content-type": "application/json" },
            body: { providerId: "openai", model: "m" },
        }),
        capture().stream,
    )
    assert.equal(withoutHeader.status, 403)

    const updated = await router(
        writeRequest("POST", "/api/models/active", {
            providerId: "openai",
            model: "gpt-5",
            reasoning: "high",
        }),
        capture().stream,
    )
    assert.equal(updated.status, 200)
    assert.deepEqual(calls.setActive, [{ providerId: "openai", model: "gpt-5", reasoning: "high" }])

    const missingProvider = await router(
        writeRequest("POST", "/api/models/active", { model: "m" }),
        capture().stream,
    )
    assert.equal(missingProvider.status, 400)
})

/* ------------------------------ 会话 CRUD ------------------------------ */

test("会话 CRUD：创建、列表、读取、改名、active、running、删除", async () => {
    const { router, store, runtime } = harness()
    const created = await router(
        writeRequest("POST", "/api/conversations", {
            title: "第一轮",
            permission: "workspace-write",
            cwd: "/tmp/project",
        }),
        capture().stream,
    )
    assert.equal(created.status, 200)
    const conversation = payloadOf(created)["conversation"] as StoredConversation
    assert.match(conversation.id, /^c[a-z0-9]{8,20}$/)
    assert.equal(conversation.title, "第一轮")
    const id = conversation.id

    const list = await router(request("GET", "/api/conversations"), capture().stream)
    assert.equal((payloadOf(list)["conversations"] as unknown[]).length, 1)

    const got = await router(request("GET", `/api/conversations/${id}`), capture().stream)
    assert.equal(got.status, 200)
    assert.equal(payloadOf(got)["running"], false)

    runtime.state.active.add(id)
    const runningGot = await router(request("GET", `/api/conversations/${id}`), capture().stream)
    assert.equal(payloadOf(runningGot)["running"], true)
    const running = await router(request("GET", "/api/running"), capture().stream)
    assert.deepEqual(payloadOf(running)["running"], [{ conversationId: id }])

    const patched = await router(
        writeRequest("PATCH", `/api/conversations/${id}`, { title: "改名", permission: "read-only" }),
        capture().stream,
    )
    assert.equal(patched.status, 200)
    const patchedConversation = payloadOf(patched)["conversation"] as StoredConversation
    assert.equal(patchedConversation.title, "改名")
    assert.equal(patchedConversation.v, 1)
    assert.deepEqual(patchedConversation.messages, [])

    const active = await router(
        writeRequest("POST", `/api/conversations/${id}/active`, {}),
        capture().stream,
    )
    assert.deepEqual(payloadOf(active), { ok: true, activeId: id })

    const deleted = await router(
        writeRequest("DELETE", `/api/conversations/${id}`),
        capture().stream,
    )
    assert.deepEqual(payloadOf(deleted), { ok: true })
    assert.deepEqual(runtime.state.stopped, [id])
    assert.equal(store.conversations.has(id), false)
})

test("会话创建：workspaceId 解析为 cwd、cwd 校验与冲突优先级", async () => {
    const { router, store, calls } = harness()
    const byWorkspace = await router(
        writeRequest("POST", "/api/conversations", { workspaceId: "ws1" }),
        capture().stream,
    )
    assert.equal(byWorkspace.status, 200)
    const byWorkspaceConversation = payloadOf(byWorkspace)["conversation"] as StoredConversation
    assert.equal(byWorkspaceConversation.workspaceId, "ws1")
    assert.equal(byWorkspaceConversation.cwd, "/tmp/project")

    const unknownWorkspace = await router(
        writeRequest("POST", "/api/conversations", { workspaceId: "missing-ws" }),
        capture().stream,
    )
    assert.equal(unknownWorkspace.status, 400)
    assert.deepEqual(payloadOf(unknownWorkspace), {
        error: "工作区不存在",
        code: "workspace-not-found",
    })

    calls.workspaceChecks.set("/tmp/missing", {
        ok: false,
        root: "/tmp/missing",
        name: "missing",
        error: "目录不存在",
    })
    const before = store.conversations.size
    const invalidCwd = await router(
        writeRequest("POST", "/api/conversations", { cwd: "/tmp/missing" }),
        capture().stream,
    )
    assert.equal(invalidCwd.status, 400)
    assert.deepEqual(payloadOf(invalidCwd), {
        error: "工作区不可用：目录不存在",
        code: "workspace-unavailable",
    })
    assert.equal(store.conversations.size, before)

    calls.workspaceChecks.set("/tmp/boom", new Error("hostApi.agent 不可用"))
    const hostFailure = await router(
        writeRequest("POST", "/api/conversations", { cwd: "/tmp/boom" }),
        capture().stream,
    )
    assert.equal(hostFailure.status, 502)
    assert.deepEqual(payloadOf(hostFailure), { error: "宿主调用失败", code: "host-error" })

    calls.workspaceListError = new Error("宿主工作区注册表不可读")
    const workspaceHostFailure = await router(
        writeRequest("POST", "/api/conversations", { workspaceId: "ws1" }),
        capture().stream,
    )
    assert.equal(workspaceHostFailure.status, 502)
    assert.deepEqual(payloadOf(workspaceHostFailure), { error: "宿主调用失败", code: "host-error" })
    calls.workspaceListError = null

    /* 同时给 workspaceId 与 cwd：cwd 为准，workspaceId 仍记录 */
    const both = await router(
        writeRequest("POST", "/api/conversations", {
            workspaceId: "ws1",
            cwd: "/tmp/explicit",
        }),
        capture().stream,
    )
    assert.equal(both.status, 200)
    const bothConversation = payloadOf(both)["conversation"] as StoredConversation
    assert.equal(bothConversation.cwd, "/tmp/explicit")
    assert.equal(bothConversation.workspaceId, "ws1")
    assert.ok(calls.validated.includes("/tmp/explicit"))
})

test("会话 PATCH：workspaceId 解析覆盖 cwd，cwd 非法时拒绝", async () => {
    const { router, store, calls } = harness()
    store.conversations.set("cabcdef12345", makeConversation("cabcdef12345"))
    const patched = await router(
        writeRequest("PATCH", "/api/conversations/cabcdef12345", { workspaceId: "ws1" }),
        capture().stream,
    )
    assert.equal(patched.status, 200)
    const conversation = payloadOf(patched)["conversation"] as StoredConversation
    assert.equal(conversation.workspaceId, "ws1")
    assert.equal(conversation.cwd, "/tmp/project")
    assert.deepEqual(conversation.messages, [])

    calls.workspaceChecks.set("/tmp/missing", {
        ok: false,
        root: "/tmp/missing",
        name: "missing",
        error: "目录不存在",
    })
    const rejected = await router(
        writeRequest("PATCH", "/api/conversations/cabcdef12345", { cwd: "/tmp/missing" }),
        capture().stream,
    )
    assert.equal(rejected.status, 400)
    assert.equal(payloadOf(rejected)["code"], "workspace-unavailable")
    assert.equal(store.conversations.get("cabcdef12345")?.cwd, "/tmp/project")
})

test("会话 CRUD：不存在的会话", async () => {
    const { router } = harness()
    const missingId = "cabcdef12345"
    for (const [method, url] of [
        ["GET", `/api/conversations/${missingId}`],
        ["PATCH", `/api/conversations/${missingId}`],
    ] as const) {
        const response = await router(
            method === "PATCH" ? writeRequest(method, url, { title: "x" }) : request(method, url),
            capture().stream,
        )
        assert.equal(response.status, 404, `${method} ${url}`)
    }
    const badId = await router(request("GET", "/api/conversations/not-an-id"), capture().stream)
    assert.equal(badId.status, 404)
    const badCreate = await router(
        writeRequest("POST", "/api/conversations", { permission: "root" }),
        capture().stream,
    )
    assert.equal(badCreate.status, 400)
})

/* ------------------------------ 对话流 ------------------------------ */

test("POST chat：SSE 立即返回、事件按序写出并结束", async () => {
    const { router, store, runtime } = harness()
    store.conversations.set("cabcdef12345", makeConversation("cabcdef12345"))
    const captured = capture()
    const response = await router(
        writeRequest("POST", "/api/conversations/cabcdef12345/chat", {
            message: "你好",
            references: ["src/a.ts"],
            permission: "read-only",
        }),
        captured.stream,
    )
    assert.equal(response.status, 200)
    assert.equal(response.stream, true)
    assert.equal(response.headers?.["content-type"], "text/event-stream; charset=utf-8")
    assert.equal(response.headers?.["cache-control"], "no-store")
    assert.equal(response.headers?.["x-accel-buffering"], "no")
    const events = chunksOf(captured)
    assert.deepEqual(
        events.map((event) => event["type"]),
        ["accepted", "delta", "done"],
    )
    assert.equal(captured.isEnded(), true)
    assert.equal(runtime.state.lastChat?.request.message, "你好")
    assert.deepEqual(runtime.state.lastChat?.request.references, ["src/a.ts"])
})

test("POST chat：校验消息、引用、权限与会话状态", async () => {
    const { router, store, runtime } = harness()
    store.conversations.set("cabcdef12345", makeConversation("cabcdef12345"))
    const url = "/api/conversations/cabcdef12345/chat"

    const empty = await router(writeRequest("POST", url, { message: "   " }), capture().stream)
    assert.equal(empty.status, 400)
    assert.match(String(empty.body), /消息不能为空/)

    const tooLong = await router(
        writeRequest("POST", url, { message: "x".repeat(21) }),
        capture().stream,
    )
    assert.equal(tooLong.status, 413)

    const tooMany = await router(
        writeRequest("POST", url, { message: "hi", references: ["a", "b", "c"] }),
        capture().stream,
    )
    assert.equal(tooMany.status, 400)

    const badPermission = await router(
        writeRequest("POST", url, { message: "hi", permission: "root" }),
        capture().stream,
    )
    assert.equal(badPermission.status, 400)

    const missing = await router(
        writeRequest("POST", "/api/conversations/cabcdef99999/chat", { message: "hi" }),
        capture().stream,
    )
    assert.equal(missing.status, 404)

    runtime.state.active.add("cabcdef12345")
    const busy = await router(writeRequest("POST", url, { message: "hi" }), capture().stream)
    assert.equal(busy.status, 409)
    assert.equal(payloadOf(busy)["code"], "busy")
})

test("POST chat：缺少 CSRF 头或非 JSON 返回 403/415", async () => {
    const { router, store } = harness()
    store.conversations.set("cabcdef12345", makeConversation("cabcdef12345"))
    const url = "/api/conversations/cabcdef12345/chat"
    const noHeader = await router(
        request("POST", url, {
            headers: { "content-type": "application/json" },
            body: { message: "hi" },
        }),
        capture().stream,
    )
    assert.equal(noHeader.status, 403)
    const wrongType = await router(
        request("POST", url, {
            headers: { "x-web-request": "1", "content-type": "text/plain" },
            body: { message: "hi" },
        }),
        capture().stream,
    )
    assert.equal(wrongType.status, 415)
    const crossOrigin = await router(
        request("POST", url, {
            headers: {
                "x-web-request": "1",
                "content-type": "application/json",
                origin: "http://evil.example",
            },
            body: { message: "hi" },
        }),
        capture().stream,
    )
    assert.equal(crossOrigin.status, 403)
})

test("GET resume：无可续接、peek、重放三种形态", async () => {
    const { router, runtime } = harness()
    const url = "/api/conversations/cabcdef12345/resume"
    const none = await router(request("GET", url), capture().stream)
    assert.equal(none.status, 200)
    assert.deepEqual(payloadOf(none), {
        ok: false,
        active: false,
        error: "没有可续接的回复",
    })

    /* peek 在无轮次时也返回完整形状 */
    const emptyPeek = await router(request("GET", `${url}?peek=1`), capture().stream)
    assert.deepEqual(payloadOf(emptyPeek), {
        ok: true,
        active: false,
        total: 0,
        done: true,
        truncated: false,
    })

    runtime.state.peek = { active: true, done: false, total: 3, truncated: false }
    const peek = await router(request("GET", `${url}?peek=1`), capture().stream)
    assert.deepEqual(payloadOf(peek), {
        ok: true,
        active: true,
        total: 3,
        done: false,
        truncated: false,
    })

    runtime.state.peek = { active: false, done: true, total: 3, truncated: true }
    const truncated = await router(request("GET", url), capture().stream)
    assert.equal(payloadOf(truncated)["ok"], false)
    assert.match(String(payloadOf(truncated)["error"]), /无法续接/)

    runtime.state.peek = { active: false, done: true, total: 3, truncated: false }
    const finished = await router(request("GET", url), capture().stream)
    assert.deepEqual(payloadOf(finished), {
        ok: false,
        active: false,
        error: "没有可续接的回复",
    })

    runtime.state.peek = { active: true, done: false, total: 3, truncated: false }
    const captured = capture()
    const streamed = await router(request("GET", `${url}?since=2`), captured.stream)
    assert.equal(streamed.status, 200)
    assert.equal(streamed.stream, true)
    assert.equal(runtime.state.lastResume?.since, 2)
    const events = chunksOf(captured)
    assert.equal(events[0]?.["type"], "resume")
    assert.equal(events[0]?.["from"], 2)
    assert.equal(captured.isEnded(), true)
})

test("POST stop / interject", async () => {
    const { router, store, runtime } = harness()
    store.conversations.set("cabcdef12345", makeConversation("cabcdef12345"))
    const stopUrl = "/api/conversations/cabcdef12345/stop"
    const stopped = await router(writeRequest("POST", stopUrl, {}), capture().stream)
    assert.deepEqual(payloadOf(stopped), { ok: true, stopped: false })
    runtime.state.stopResult = true
    const stoppedAgain = await router(writeRequest("POST", stopUrl, {}), capture().stream)
    assert.deepEqual(payloadOf(stoppedAgain), { ok: true, stopped: true })

    const interjectUrl = "/api/conversations/cabcdef12345/interject"
    const injected = await router(
        writeRequest("POST", interjectUrl, { message: "补充一句" }),
        capturedStreamPass(),
    )
    assert.deepEqual(payloadOf(injected), { ok: true, accepted: true })
    assert.equal(runtime.state.lastInterject?.message, "补充一句")

    runtime.state.interjectResult = false
    const ended = await router(
        writeRequest("POST", interjectUrl, { message: "补充" }),
        capture().stream,
    )
    assert.equal(ended.status, 409)

    const empty = await router(writeRequest("POST", interjectUrl, { message: "" }), capture().stream)
    assert.equal(empty.status, 400)
})

function capturedStreamPass(): HttpStreamContext {
    return capture().stream
}

test("提问与审批应答：accepted / stale", async () => {
    const { router, runtime } = harness()
    const ask = await router(
        writeRequest("POST", "/api/asks/ask-1", { answer: "是" }),
        capture().stream,
    )
    assert.deepEqual(payloadOf(ask), { ok: true, accepted: true, stale: false })
    runtime.state.askResult = false
    const staleAsk = await router(
        writeRequest("POST", "/api/asks/ask-1", { answer: "是" }),
        capture().stream,
    )
    assert.deepEqual(payloadOf(staleAsk), { ok: true, accepted: false, stale: true })
    const badAsk = await router(writeRequest("POST", "/api/asks/ask-1", {}), capture().stream)
    assert.equal(badAsk.status, 400)

    const approval = await router(
        writeRequest("POST", "/api/approvals/ap-1", { approved: true }),
        capture().stream,
    )
    assert.deepEqual(payloadOf(approval), { ok: true, accepted: true, stale: false })
    const badApproval = await router(
        writeRequest("POST", "/api/approvals/ap-1", { approved: "yes" }),
        capture().stream,
    )
    assert.equal(badApproval.status, 400)
})

/* ------------------------------ 工作区与文件 ------------------------------ */

test("工作区：列表、校验、按路径添加、选择器添加、删除", async () => {
    const { router, calls } = harness()
    const list = await router(request("GET", "/api/workspaces"), capture().stream)
    assert.equal((payloadOf(list)["workspaces"] as unknown[]).length, 1)

    const validated = await router(
        writeRequest("POST", "/api/workspaces/validate", { root: "/tmp/project" }),
        capture().stream,
    )
    assert.deepEqual(payloadOf(validated), { ok: true, root: "/tmp/project", name: "project" })

    const added = await router(
        writeRequest("POST", "/api/workspaces", { root: "/tmp/project", name: "项目" }),
        capture().stream,
    )
    assert.equal(added.status, 200)
    assert.deepEqual(calls.added, [{ root: "/tmp/project", name: "项目" }])

    const picked = await router(
        writeRequest("POST", "/api/workspaces", { pick: true }),
        capture().stream,
    )
    assert.equal(picked.status, 200)
    assert.deepEqual(calls.added[1], { root: "/tmp/picked" })

    const relative = await router(
        writeRequest("POST", "/api/workspaces", { root: "relative/path" }),
        capture().stream,
    )
    assert.equal(relative.status, 400)

    const removed = await router(
        writeRequest("DELETE", "/api/workspaces/ws1"),
        capture().stream,
    )
    assert.deepEqual(calls.removed, ["ws1"])
    assert.equal(payloadOf(removed)["ok"], true)
})

test("文件：搜索与打开", async () => {
    const { router, calls } = harness()
    const missingRoot = await router(request("GET", "/api/files?q=a"), capture().stream)
    assert.equal(missingRoot.status, 400)
    const search = await router(
        request("GET", "/api/files?root=%2Ftmp%2Fproject&q=src"),
        capture().stream,
    )
    assert.equal(search.status, 200)
    assert.equal((payloadOf(search)["entries"] as unknown[]).length, 1)
    assert.equal(payloadOf(search)["root"], "/tmp/project")

    const opened = await router(
        writeRequest("POST", "/api/files/open", { path: "/tmp/project/a.txt", mode: "reveal" }),
        capture().stream,
    )
    assert.deepEqual(payloadOf(opened), { ok: true })
    assert.deepEqual(calls.opened, [{ path: "/tmp/project/a.txt", mode: "reveal" }])
    const badMode = await router(
        writeRequest("POST", "/api/files/open", { path: "/tmp/a", mode: "edit" }),
        capture().stream,
    )
    assert.equal(badMode.status, 400)
})

/* ------------------------------ 路由边界 ------------------------------ */

test("未知接口 404、方法不允许 405、路径参数非法 400", async () => {
    const { router } = harness()
    const unknown = await router(
        writeRequest("POST", "/api/unknown", undefined),
        capture().stream,
    )
    assert.equal(unknown.status, 404)
    assert.equal(payloadOf(unknown)["code"], "not-found")

    const wrongMethod = await router(request("PATCH", "/api/bootstrap"), capture().stream)
    assert.equal(wrongMethod.status, 405)
    assert.match(String(wrongMethod.headers?.["allow"]), /GET/)

    /* 未命中路由优先 404，不触发写请求校验 */
    const unknownNoGuard = await router(request("POST", "/api/unknown"), capture().stream)
    assert.equal(unknownNoGuard.status, 404)

    const badParam = await router(request("GET", "/api/conversations/%E0%A4%A"), capture().stream)
    assert.equal(badParam.status, 400)
})

test("handler 抛错时返回 500 JSON 而不是中断连接", async () => {
    const { router, store, runtime } = harness()
    store.conversations.set("cabcdef12345", makeConversation("cabcdef12345"))
    runtime.state.startThrows = true
    const response = await router(
        writeRequest("POST", "/api/conversations/cabcdef12345/chat", { message: "hi" }),
        capture().stream,
    )
    assert.equal(response.status, 500)
    assert.deepEqual(payloadOf(response), { error: "服务器内部错误", code: "internal" })
    assert.equal(response.headers?.["x-frame-options"], "DENY")
})

test("空请求体写接口：允许（如 active/stop）", async () => {
    const { router, store } = harness()
    store.conversations.set("cabcdef12345", makeConversation("cabcdef12345"))
    const response = await router(
        request("POST", "/api/conversations/cabcdef12345/active", {
            headers: { "x-web-request": "1" },
        }),
        capture().stream,
    )
    assert.equal(response.status, 200)
    assert.deepEqual(payloadOf(response), { ok: true, activeId: "cabcdef12345" })
})

test("会话摘要辅助去掉 messages 与版本字段", () => {
    const summary = summaryOf(makeConversation("cabcdef12345"))
    assert.equal(summary.id, "cabcdef12345")
    assert.equal((summary as unknown as Record<string, unknown>)["messages"], undefined)
})
