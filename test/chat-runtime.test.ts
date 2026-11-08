import assert from "node:assert/strict"
import { test } from "node:test"

import type {
    HostAgentChatInput,
    HostAgentChatResult,
    HostAgentStreamEvent,
    HttpStreamContext,
} from "wellspring/api/host/index.ts"

import type { ChatLimits, ChatStreamEvent, Usage } from "../src/chat-types.ts"
import { ChatRuntime, mapChatError } from "../src/chat-runtime.ts"
import type { ChatAgentApi, ChatErrorMapping } from "../src/chat-runtime.ts"
import { ChatStore } from "../src/chat-store.ts"
import type { ChatLogger, HostFileApiLike } from "../src/chat-store.ts"
import { MemoryFs } from "./helpers/memory-fs.ts"

const SESSION_ID = "20261108-080000-abcd"

/* ------------------------------ 测试替身 ------------------------------ */

function createFileApi(memory: MemoryFs): HostFileApiLike {
    return {
        root: "/plugin-data",
        async readJson<T = unknown>(path: string): Promise<T | null> {
            const text = await memory.text(path)
            return text === null ? null : (JSON.parse(text) as T)
        },
        async writeJson(path: string, value: unknown): Promise<void> {
            await memory.writeText(path, `${JSON.stringify(value, null, 4)}\n`)
        },
        async mkdir(path: string): Promise<void> {
            await memory.mkdir(path)
        },
        async list(path = ""): Promise<readonly { name: string; type: string }[]> {
            const prefix = path === "" ? "" : `${path}/`
            const entries: { name: string; type: string }[] = []
            for (const filePath of memory.files.keys()) {
                if (!filePath.startsWith(prefix)) {
                    continue
                }
                const rest = filePath.slice(prefix.length)
                if (rest === "" || rest.includes("/")) {
                    continue
                }
                entries.push({ name: rest, type: "file" })
            }
            return entries
        },
        async remove(path: string): Promise<void> {
            memory.files.delete(path)
        },
        async exists(path: string): Promise<boolean> {
            return memory.files.has(path) || memory.dirs.has(path)
        },
    }
}

interface TestStream extends HttpStreamContext {
    readonly chunks: string[]
    isEnded(): boolean
}

function createStream(): TestStream {
    const chunks: string[] = []
    let ended = false
    return {
        chunks,
        isEnded: () => ended,
        write(chunk: string): void {
            chunks.push(chunk)
        },
        end(): void {
            ended = true
        },
    }
}

interface FakeResultOverrides {
    readonly sessionId?: string
    readonly turn?: number
    readonly steps?: number
    readonly reply?: string
    readonly model?: string
    readonly usage?: Usage | null
}

class FakeAgent implements ChatAgentApi {
    readonly inputs: HostAgentChatInput[] = []
    readonly handlers: ((event: HostAgentStreamEvent) => void)[] = []
    readonly stoppedSessionIds: string[] = []
    readonly interjections: { sessionId: string; message: string }[] = []
    readonly answeredAsks: { askId: string; answer: string }[] = []
    readonly answeredApprovals: { approvalId: string; approved: boolean }[] = []
    interjectResult = true
    respondAskResult = true
    respondApprovalResult = true

    readonly #resolvers: ((result: HostAgentChatResult) => void)[] = []
    readonly #rejecters: ((error: Error) => void)[] = []

    stream(
        input: HostAgentChatInput,
        onEvent: (event: HostAgentStreamEvent) => void,
    ): Promise<HostAgentChatResult> {
        this.inputs.push(input)
        this.handlers.push(onEvent)
        return new Promise<HostAgentChatResult>((resolve, reject) => {
            this.#resolvers.push(resolve)
            this.#rejecters.push(reject)
        })
    }

    emit(event: HostAgentStreamEvent): void {
        const handler = this.handlers[this.handlers.length - 1]
        assert.ok(handler !== undefined, "宿主流处理器已注册")
        handler(event)
    }

    finish(overrides: FakeResultOverrides = {}, index = this.handlers.length - 1): void {
        const resolve = this.#resolvers[index]
        assert.ok(resolve !== undefined, "宿主流 Promise 存在")
        resolve({
            sessionId: overrides.sessionId ?? SESSION_ID,
            turn: overrides.turn ?? 1,
            steps: overrides.steps ?? 1,
            reply: overrides.reply ?? "回复正文",
            model: overrides.model ?? "test-model",
            usage: overrides.usage === undefined ? { inputTokens: 10, outputTokens: 20 } : overrides.usage,
        })
    }

    fail(error: Error, index = this.handlers.length - 1): void {
        const reject = this.#rejecters[index]
        assert.ok(reject !== undefined, "宿主流 Promise 存在")
        reject(error)
    }

    async stop(sessionId: string): Promise<boolean> {
        this.stoppedSessionIds.push(sessionId)
        return true
    }

    async interject(sessionId: string, message: string): Promise<boolean> {
        this.interjections.push({ sessionId, message })
        return this.interjectResult
    }

    async respondAsk(askId: string, answer: string): Promise<boolean> {
        this.answeredAsks.push({ askId, answer })
        return this.respondAskResult
    }

    async respondApproval(approvalId: string, approved: boolean): Promise<boolean> {
        this.answeredApprovals.push({ approvalId, approved })
        return this.respondApprovalResult
    }
}

interface RuntimeHarness {
    readonly memory: MemoryFs
    readonly store: ChatStore
    readonly agent: FakeAgent
    readonly runtime: ChatRuntime
    readonly logs: string[]
}

function createHarness(runtimeLimits?: Partial<ChatLimits>): RuntimeHarness {
    const memory = new MemoryFs()
    const logs: string[] = []
    const logger: ChatLogger = {
        warn(_data: unknown, message?: string) {
            logs.push(message ?? "")
        },
    }
    const store = new ChatStore({ fs: createFileApi(memory), logger })
    const agent = new FakeAgent()
    const runtime = new ChatRuntime({
        agent,
        store,
        ...(runtimeLimits === undefined ? {} : { limits: runtimeLimits }),
        logger,
    })
    return { memory, store, agent, runtime, logs }
}

/* ------------------------------ 工具 ------------------------------ */

async function waitFor(
    check: () => boolean | Promise<boolean>,
    message = "等待条件超时",
    timeoutMs = 2000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (await check()) {
            return
        }
        await new Promise((resolve) => setTimeout(resolve, 2))
    }
    assert.fail(message)
}

function eventsOf(stream: TestStream): ChatStreamEvent[] {
    return stream.chunks.map((chunk) => {
        assert.ok(chunk.startsWith("data: "), `chunk 前缀：${chunk.slice(0, 20)}`)
        assert.ok(chunk.endsWith("\n\n"), "chunk 结尾")
        return JSON.parse(chunk.slice("data: ".length, -2)) as ChatStreamEvent
    })
}

function eventTypes(stream: TestStream): string[] {
    return eventsOf(stream).map((event) => event.type)
}

function eventsByType<T extends ChatStreamEvent["type"]>(
    events: ChatStreamEvent[],
    type: T,
): Extract<ChatStreamEvent, { type: T }>[] {
    return events.filter((event): event is Extract<ChatStreamEvent, { type: T }> => event.type === type)
}

async function startTurn(
    harness: RuntimeHarness,
    conversationId: string,
    message = "你好",
): Promise<TestStream> {
    const stream = createStream()
    await harness.runtime.startTurn(conversationId, { message }, stream)
    return stream
}

async function assistantMessage(harness: RuntimeHarness, conversationId: string) {
    const conversation = await harness.store.get(conversationId)
    assert.ok(conversation !== null, "会话存在")
    return conversation.messages.find((message) => message.role === "assistant")
}

/* ------------------------------ 用例 ------------------------------ */

test("startTurn：先落库再写 accepted，session/delta 事件映射与 done 收尾", async () => {
    const harness = createHarness()
    const conversation = await harness.store.create({ cwd: "/tmp/ws" })
    const stream = await startTurn(harness, conversation.id, "  你好  ")

    const accepted = eventsByType(eventsOf(stream), "accepted")[0]
    assert.ok(accepted !== undefined)
    assert.equal(accepted.conversationId, conversation.id)

    const stored = await harness.store.get(conversation.id)
    assert.ok(stored !== null)
    assert.equal(stored.messages.length, 2)
    assert.equal(stored.messages[0]?.role, "user")
    assert.equal(stored.messages[0]?.text, "你好")
    assert.equal(stored.messages[0]?.id, accepted.userMessageId)
    assert.equal(stored.messages[1]?.role, "assistant")
    assert.equal(stored.messages[1]?.status, "streaming")
    assert.equal(stored.messages[1]?.id, accepted.assistantMessageId)
    assert.equal(harness.runtime.isRunning(conversation.id), true)
    assert.deepEqual(harness.runtime.running(), [conversation.id])

    harness.agent.emit({ type: "session", sessionId: SESSION_ID })
    harness.agent.emit({ type: "step", turn: 1, step: 1 })
    harness.agent.emit({ type: "reasoning", text: "想一想" })
    harness.agent.emit({ type: "delta", text: "你" })
    harness.agent.emit({ type: "delta", text: "好" })
    harness.agent.finish({ reply: "你好" })

    await waitFor(() => stream.isEnded(), "流已结束")
    const events = eventsOf(stream)
    assert.deepEqual(
        events.map((event) => event.type),
        ["accepted", "session", "step", "reasoning", "delta", "delta", "done"],
    )
    const done = eventsByType(events, "done")[0]
    assert.ok(done !== undefined)
    assert.deepEqual(done, {
        type: "done",
        sessionId: SESSION_ID,
        turn: 1,
        steps: 1,
        reply: "你好",
        model: "test-model",
        usage: { inputTokens: 10, outputTokens: 20 },
    })

    await waitFor(async () => (await assistantMessage(harness, conversation.id))?.status === "done")
    const assistant = await assistantMessage(harness, conversation.id)
    assert.ok(assistant !== undefined)
    assert.equal(assistant.text, "你好")
    assert.equal(assistant.model, "test-model")
    assert.equal(assistant.turn, 1)
    assert.equal(assistant.steps, 1)
    assert.deepEqual(assistant.usage, { inputTokens: 10, outputTokens: 20 })
    assert.ok(assistant.endedAt !== undefined)

    const reasoning = assistant.blocks.find((block) => block.type === "reasoning")
    assert.ok(reasoning !== undefined && reasoning.type === "reasoning")
    assert.equal(reasoning.text, "想一想")
    assert.ok(reasoning.endedAt !== null)
    const textBlock = assistant.blocks.find((block) => block.type === "text")
    assert.ok(textBlock !== undefined && textBlock.type === "text")
    assert.equal(textBlock.text, "你好")

    const summary = harness.store.list()[0]
    assert.equal(summary?.sessionId, SESSION_ID)
    assert.equal(summary?.last?.status, "done")
    assert.deepEqual(summary?.usage, { inputTokens: 10, outputTokens: 20 })
    assert.equal(summary?.turns, 1)
    assert.equal(harness.runtime.running().length, 0)
    // 宿主入参：cwd 与宿主会话 id 复用
    assert.equal(harness.agent.inputs[0]?.cwd, "/tmp/ws")
    assert.equal(harness.agent.inputs[0]?.sessionId, undefined)
    assert.equal(harness.agent.inputs[0]?.permission, "read-only")
})

test("tool：start/end 合并为同一过程块，成功与失败状态正确", async () => {
    const harness = createHarness()
    const conversation = await harness.store.create()
    const stream = await startTurn(harness, conversation.id)
    harness.agent.emit({ type: "session", sessionId: SESSION_ID })
    harness.agent.emit({
        type: "tool",
        id: "t1",
        name: "read_file",
        phase: "start",
        arguments: '{"path":"a.txt"}',
    })
    harness.agent.emit({
        type: "tool",
        id: "t1",
        name: "read_file",
        phase: "end",
        ok: true,
        result: "文件内容",
        truncated: false,
    })
    harness.agent.emit({ type: "tool", id: "t2", name: "write_file", phase: "start" })
    harness.agent.emit({ type: "tool", id: "t2", name: "write_file", phase: "end", ok: false })

    const toolEvents = eventsByType(eventsOf(stream), "tool")
    assert.equal(toolEvents.length, 4)
    assert.deepEqual(toolEvents[0], {
        type: "tool",
        id: "t1",
        name: "read_file",
        phase: "start",
        arguments: '{"path":"a.txt"}',
    })
    assert.equal(toolEvents[1]?.result, "文件内容")

    harness.agent.finish()
    await waitFor(() => stream.isEnded())
    await waitFor(async () => {
        const assistant = await assistantMessage(harness, conversation.id)
        return assistant?.blocks.filter((block) => block.type === "tool").length === 2
    })
    const assistant = await assistantMessage(harness, conversation.id)
    const tools = (assistant?.blocks ?? []).filter((block) => block.type === "tool")
    assert.equal(tools[0]?.type === "tool" && tools[0].status, "ok")
    assert.equal(tools[0]?.type === "tool" && tools[0].result, "文件内容")
    assert.equal(tools[1]?.type === "tool" && tools[1].status, "error")
    assert.ok(tools[0]?.type === "tool" && tools[0].endedAt !== null)
})

test("请求覆盖：权限/模型/推理/references 透传，缺省用会话设置", async () => {
    const harness = createHarness()
    const conversation = await harness.store.create({
        permission: "workspace-write",
        provider: "provider-a",
        model: "model-a",
        reasoning: "low",
    })
    const stream = await startTurn(harness, conversation.id, "带覆盖")
    harness.agent.emit({ type: "session", sessionId: SESSION_ID })
    harness.agent.finish()
    await waitFor(() => stream.isEnded())
    assert.equal(harness.agent.inputs[0]?.permission, "workspace-write")
    assert.equal(harness.agent.inputs[0]?.provider, "provider-a")
    assert.equal(harness.agent.inputs[0]?.model, "model-a")
    assert.equal(harness.agent.inputs[0]?.reasoning, "low")

    const override = createStream()
    await harness.runtime.startTurn(
        conversation.id,
        {
            message: "覆盖设置",
            permission: "danger-full-access",
            provider: "provider-b",
            model: "model-b",
            reasoning: "max",
            references: ["a.txt", "", "b/c.ts", 42 as unknown as string],
        },
        override,
    )
    assert.equal(harness.agent.inputs[1]?.permission, "danger-full-access")
    assert.equal(harness.agent.inputs[1]?.provider, "provider-b")
    assert.equal(harness.agent.inputs[1]?.model, "model-b")
    assert.equal(harness.agent.inputs[1]?.reasoning, "max")
    assert.deepEqual(harness.agent.inputs[1]?.references, ["a.txt", "b/c.ts"])
    harness.agent.emit({ type: "session", sessionId: SESSION_ID })
    harness.agent.finish({ turn: 2 })
    await waitFor(() => override.isEnded())
})

test("多轮：第二轮带上第一轮的 sessionId 与 cwd", async () => {
    const harness = createHarness()
    const conversation = await harness.store.create({ cwd: "/tmp/ws" })
    const first = await startTurn(harness, conversation.id, "第一轮")
    harness.agent.emit({ type: "session", sessionId: SESSION_ID })
    harness.agent.finish()
    await waitFor(() => first.isEnded())

    const second = await startTurn(harness, conversation.id, "第二轮")
    assert.equal(harness.agent.inputs[1]?.sessionId, SESSION_ID)
    assert.equal(harness.agent.inputs[1]?.cwd, "/tmp/ws")
    harness.agent.emit({ type: "session", sessionId: SESSION_ID })
    harness.agent.emit({ type: "delta", text: "继续" })
    harness.agent.finish({ turn: 2, steps: 2 })
    await waitFor(() => second.isEnded())
    const conversationAfter = await harness.store.get(conversation.id)
    assert.equal(conversationAfter?.messages.length, 4)
    assert.equal(conversationAfter?.turns, 2)
})

test("stop：立即发 stopped、调用宿主 stop、宿主 resolve 后按停止收尾且不发 done", async () => {
    const harness = createHarness()
    const conversation = await harness.store.create()
    const stream = await startTurn(harness, conversation.id)
    harness.agent.emit({ type: "session", sessionId: SESSION_ID })
    harness.agent.emit({ type: "delta", text: "已收到的正文" })

    assert.equal(await harness.runtime.stop(conversation.id), true)
    assert.deepEqual(harness.agent.stoppedSessionIds, [SESSION_ID])
    assert.equal(stream.isEnded(), true)
    assert.equal(harness.runtime.isRunning(conversation.id), false)
    assert.equal(await harness.runtime.stop(conversation.id), false)
    assert.equal(eventsOf(stream).at(-1)?.type, "stopped")
    // stop 返回时 stopped 状态已落盘，刷新后与流事件一致
    assert.equal((await assistantMessage(harness, conversation.id))?.status, "stopped")

    // 停止后到达的事件被忽略
    const chunkCount = stream.chunks.length
    harness.agent.emit({ type: "delta", text: "停止后的增量" })
    assert.equal(stream.chunks.length, chunkCount)

    harness.agent.finish({ reply: "宿主最终结果" })
    await waitFor(async () => (await assistantMessage(harness, conversation.id))?.status === "stopped")
    const assistant = await assistantMessage(harness, conversation.id)
    assert.ok(assistant !== undefined)
    assert.equal(assistant.text, "已收到的正文")
    assert.ok(!eventsOf(stream).some((event) => event.type === "done"))
    // 保留轮次可 peek/resume
    assert.equal(harness.runtime.peek(conversation.id)?.done, true)
    assert.equal(harness.runtime.peek(conversation.id)?.active, false)
})

test("提问：转发 ask，应答后缓冲 chunk 改写为 request:null 并记录答案", async () => {
    const harness = createHarness()
    const conversation = await harness.store.create()
    const stream = await startTurn(harness, conversation.id)
    harness.agent.emit({ type: "session", sessionId: SESSION_ID })
    harness.agent.emit({
        type: "ask",
        request: { askId: "ask-1", question: "选哪个", options: ["a", "b"] },
    })
    const askEvent = eventsByType(eventsOf(stream), "ask")[0]
    assert.ok(askEvent !== undefined)
    assert.deepEqual(askEvent.request, { askId: "ask-1", question: "选哪个", options: ["a", "b"] })

    assert.equal(await harness.runtime.respondAsk("ask-1", "a"), true)
    assert.deepEqual(harness.agent.answeredAsks, [{ askId: "ask-1", answer: "a" }])

    // 续接重放里 request 已中和
    const replay = createStream()
    await harness.runtime.resume(conversation.id, 0, replay)
    const replayedAsks = eventsByType(eventsOf(replay), "ask")
    assert.equal(replayedAsks.length, 1)
    assert.equal(replayedAsks[0]?.request, null)
    assert.equal(replayedAsks[0]?.askId, "ask-1")

    await waitFor(async () => {
        const assistant = await assistantMessage(harness, conversation.id)
        return assistant?.blocks.some((block) => block.type === "ask" && block.answer === "a") === true
    })

    // 宿主返回 false 即 stale
    harness.agent.respondAskResult = false
    assert.equal(await harness.runtime.respondAsk("ask-2", "x"), false)
})

test("审批：转发 approval，应答后 chunk 中和并记录结论", async () => {
    const harness = createHarness()
    const conversation = await harness.store.create()
    const stream = await startTurn(harness, conversation.id)
    harness.agent.emit({ type: "session", sessionId: SESSION_ID })
    harness.agent.emit({
        type: "approval",
        request: {
            approvalId: "apv-1",
            command: "rm",
            argv: ["rm", "-rf", "build"],
            cwd: "/tmp/ws",
            currentPermission: "read-only",
            requestedPermission: "workspace-write",
            justification: "清理构建产物",
        },
    })
    const approvalEvent = eventsByType(eventsOf(stream), "approval")[0]
    assert.ok(approvalEvent !== undefined)
    assert.equal(approvalEvent.request?.approvalId, "apv-1")
    assert.deepEqual(approvalEvent.request?.argv, ["rm", "-rf", "build"])

    assert.equal(await harness.runtime.respondApproval("apv-1", true), true)
    assert.deepEqual(harness.agent.answeredApprovals, [{ approvalId: "apv-1", approved: true }])

    const replay = createStream()
    await harness.runtime.resume(conversation.id, 0, replay)
    const replayed = eventsByType(eventsOf(replay), "approval")
    assert.equal(replayed[0]?.request, null)

    await waitFor(async () => {
        const assistant = await assistantMessage(harness, conversation.id)
        return assistant?.blocks.some((block) => block.type === "approval" && block.approved === true) === true
    })
})

test("sandbox-prepare：按 sessionId 投递到活跃轮次缓冲", async () => {
    const harness = createHarness()
    const conversation = await harness.store.create()
    const stream = await startTurn(harness, conversation.id)
    harness.agent.emit({ type: "session", sessionId: SESSION_ID })
    assert.equal(
        harness.runtime.injectSandboxPrepare({ sessionId: SESSION_ID, workspaceDir: "/tmp/ws", phase: "started" }),
        1,
    )
    assert.equal(
        harness.runtime.injectSandboxPrepare({ sessionId: "other-session", workspaceDir: "/tmp/ws", phase: "started" }),
        0,
    )
    assert.equal(
        harness.runtime.injectSandboxPrepare({ workspaceDir: "/tmp/ws", phase: "completed", elapsedMs: 12 }),
        1,
    )
    const prepares = eventsByType(eventsOf(stream), "sandbox-prepare")
    assert.equal(prepares.length, 2)
    assert.deepEqual(prepares[0], {
        type: "sandbox-prepare",
        phase: "started",
        workspaceDir: "/tmp/ws",
        sessionId: SESSION_ID,
    })
    assert.equal(prepares[1]?.elapsedMs, 12)
    harness.agent.finish()
    await waitFor(() => stream.isEnded())
    assert.equal(harness.runtime.injectSandboxPrepare({ workspaceDir: "/tmp/ws", phase: "completed" }), 0)
})

test("interject：宿主接收后发 steer 事件并写入过程块；无会话/无轮次返回 false", async () => {
    const harness = createHarness()
    const conversation = await harness.store.create()
    assert.equal(await harness.runtime.interject(conversation.id, "插话"), false)

    const stream = await startTurn(harness, conversation.id)
    // 还没有 session 事件
    assert.equal(await harness.runtime.interject(conversation.id, "插话"), false)
    harness.agent.emit({ type: "session", sessionId: SESSION_ID })
    assert.equal(await harness.runtime.interject(conversation.id, " 再查一下 "), true)
    assert.deepEqual(harness.agent.interjections, [{ sessionId: SESSION_ID, message: "再查一下" }])
    const steer = eventsByType(eventsOf(stream), "steer")[0]
    assert.ok(steer !== undefined)
    assert.equal(steer.text, "再查一下")
    assert.equal(typeof steer.at, "number")

    harness.agent.interjectResult = false
    assert.equal(await harness.runtime.interject(conversation.id, "再次插话"), false)

    harness.agent.finish()
    await waitFor(() => stream.isEnded())
    await waitFor(async () => {
        const assistant = await assistantMessage(harness, conversation.id)
        return assistant?.blocks.some((block) => block.type === "steer" && block.text === "再查一下") === true
    })
    assert.equal(await harness.runtime.interject(conversation.id, "轮次已结束"), false)
})

test("resume：先写 resume 标记再按 since 重放，越界回退全量，结束后关闭", async () => {
    const harness = createHarness()
    const conversation = await harness.store.create()
    const stream = await startTurn(harness, conversation.id)
    harness.agent.emit({ type: "session", sessionId: SESSION_ID })
    harness.agent.emit({ type: "delta", text: "一" })
    harness.agent.emit({ type: "delta", text: "二" })

    // accepted + session + delta + delta
    assert.equal(harness.runtime.peek(conversation.id)?.total, 4)

    const partial = createStream()
    await harness.runtime.resume(conversation.id, 2, partial)
    const partialEvents = eventsOf(partial)
    assert.deepEqual(partialEvents[0], { type: "resume", active: true, from: 2, total: 4 })
    assert.equal(partialEvents.length, 3)
    assert.equal(partialEvents[1]?.type, "delta")

    const outOfRange = createStream()
    await harness.runtime.resume(conversation.id, 99, outOfRange)
    const fullEvents = eventsOf(outOfRange)
    assert.deepEqual(fullEvents[0], { type: "resume", active: true, from: 0, total: 4 })
    assert.equal(fullEvents.length, 5)

    // 未结束则继续实时推送
    harness.agent.emit({ type: "delta", text: "三" })
    assert.equal(eventsOf(partial).at(-1)?.type, "delta")
    assert.equal(partial.isEnded(), false)
    harness.agent.finish()
    await waitFor(() => partial.isEnded())
    assert.equal(eventsOf(partial).at(-1)?.type, "done")

    // 已结束的保留轮次：重放含 done 并立即关闭
    const finished = createStream()
    await harness.runtime.resume(conversation.id, 0, finished)
    const finishedEvents = eventsOf(finished)
    assert.deepEqual(finishedEvents[0], { type: "resume", active: false, from: 0, total: 6 })
    assert.equal(finishedEvents.at(-1)?.type, "done")
    assert.equal(finished.isEnded(), true)

    // 无轮次
    const missing = createStream()
    await harness.runtime.resume("c00000000", 0, missing)
    const missingEvents = eventsOf(missing)
    assert.equal(missingEvents[0]?.type, "error")
    assert.equal(missing.isEnded(), true)
})

test("truncated：缓冲超限后丢弃缓冲、实时推送继续，resume 拒绝续接", async () => {
    const harness = createHarness({ turnBufferChars: 360 })
    const conversation = await harness.store.create()
    const stream = await startTurn(harness, conversation.id)
    harness.agent.emit({ type: "session", sessionId: SESSION_ID })
    harness.agent.emit({ type: "delta", text: "甲".repeat(40) })
    harness.agent.emit({ type: "delta", text: "乙".repeat(40) })
    harness.agent.emit({ type: "delta", text: "丙".repeat(40) })

    const events = eventsOf(stream)
    assert.ok(events.some((event) => event.type === "truncated"))
    const deltaCount = events.filter((event) => event.type === "delta").length
    assert.equal(deltaCount, 3)
    assert.equal(harness.runtime.peek(conversation.id)?.truncated, true)

    const resumeStream = createStream()
    await harness.runtime.resume(conversation.id, 0, resumeStream)
    assert.equal(eventsOf(resumeStream)[0]?.type, "error")
    assert.equal(resumeStream.isEnded(), true)
})

test("replaced：同会话开始新一轮时旧流收到 replaced 并关闭，旧消息标记 interrupted", async () => {
    const harness = createHarness()
    const conversation = await harness.store.create()
    const first = await startTurn(harness, conversation.id, "第一轮")
    harness.agent.emit({ type: "session", sessionId: SESSION_ID })
    harness.agent.emit({ type: "delta", text: "旧流内容" })

    const second = await startTurn(harness, conversation.id, "第二轮")
    assert.equal(first.isEnded(), true)
    assert.equal(eventsOf(first).at(-1)?.type, "replaced")
    assert.equal(eventsOf(second)[0]?.type, "accepted")

    await waitFor(async () => {
        const stored = await harness.store.get(conversation.id)
        const assistants = stored?.messages.filter((message) => message.role === "assistant") ?? []
        return assistants[0]?.status === "interrupted"
    })
    harness.agent.finish({}, 0)
    harness.agent.emit({ type: "session", sessionId: SESSION_ID })
    harness.agent.finish()
    await waitFor(() => second.isEnded())

    const stored = await harness.store.get(conversation.id)
    assert.equal(stored?.messages.length, 4)
    const assistants = stored?.messages.filter((message) => message.role === "assistant") ?? []
    assert.equal(assistants[0]?.status, "interrupted")
    assert.equal(assistants[1]?.status, "done")
})

test("错误映射：宿主 reject 映射为中文 error 事件，保留已收正文", async () => {
    const harness = createHarness()
    const conversation = await harness.store.create()
    const stream = await startTurn(harness, conversation.id)
    harness.agent.emit({ type: "session", sessionId: SESSION_ID })
    harness.agent.emit({ type: "delta", text: "部分正文" })
    harness.agent.fail(new Error("openai.missing-api-key"))

    await waitFor(() => stream.isEnded())
    const error = eventsByType(eventsOf(stream), "error")[0]
    assert.ok(error !== undefined)
    assert.equal(error.error, "缺少 API Key")
    assert.equal(error.code, "missing-api-key")

    await waitFor(async () => (await assistantMessage(harness, conversation.id))?.status === "error")
    const assistant = await assistantMessage(harness, conversation.id)
    assert.ok(assistant !== undefined)
    assert.equal(assistant.text, "部分正文")
    assert.equal(assistant.error, "缺少 API Key")

    const cases: { input: unknown; expected: ChatErrorMapping }[] = [
        {
            input: new Error("工作区不可用：目录不存在"),
            expected: { error: "工作区不可用：目录不存在", code: "workspace-unavailable" },
        },
        {
            input: new Error("会话不存在：20260101-000000-abcd"),
            expected: { error: "宿主会话不存在，无法继续", code: "session-not-found" },
        },
        {
            input: new Error("插件没有 hostApi.agent 权限"),
            expected: { error: "插件缺少 agent 权限", code: "agent-permission" },
        },
        {
            input: new Error("openai.request-failed:timeout"),
            expected: { error: "模型请求失败：timeout", code: "model-request-failed" },
        },
        {
            input: new Error("未知错误"),
            expected: { error: "未知错误", code: "chat-failed" },
        },
        { input: new Error(""), expected: { error: "对话失败", code: "chat-failed" } },
    ]
    for (const item of cases) {
        assert.deepEqual(mapChatError(item.input), item.expected, String(item.input))
    }
})

test("startTurn 预检：会话不存在/消息为空写 error 事件并关闭流", async () => {
    const harness = createHarness()
    const missing = createStream()
    await harness.runtime.startTurn("c00000000", { message: "你好" }, missing)
    const missingError = eventsByType(eventsOf(missing), "error")[0]
    assert.equal(missingError?.code, "conversation-not-found")
    assert.equal(missing.isEnded(), true)
    assert.equal(harness.agent.inputs.length, 0)

    const conversation = await harness.store.create()
    const empty = createStream()
    await harness.runtime.startTurn(conversation.id, { message: "   " }, empty)
    assert.equal(eventsByType(eventsOf(empty), "error")[0]?.code, "invalid-request")
    assert.equal(empty.isEnded(), true)
})

test("并发启动：同一会话重叠 startTurn 时后一个写 busy 错误", async () => {
    const harness = createHarness()
    const conversation = await harness.store.create()
    const first = createStream()
    const second = createStream()
    await Promise.all([
        harness.runtime.startTurn(conversation.id, { message: "第一个" }, first),
        harness.runtime.startTurn(conversation.id, { message: "第二个" }, second),
    ])
    assert.equal(eventsByType(eventsOf(first), "accepted").length, 1)
    assert.equal(eventsByType(eventsOf(second), "error")[0]?.code, "busy")
    assert.equal(second.isEnded(), true)
    harness.agent.finish()
    await waitFor(() => first.isEnded())
})

test("dispose：关闭订阅并把进行中的消息标记 interrupted", async () => {
    const harness = createHarness()
    const conversation = await harness.store.create()
    const stream = await startTurn(harness, conversation.id)
    harness.agent.emit({ type: "session", sessionId: SESSION_ID })
    harness.agent.emit({ type: "delta", text: "未完成" })

    await harness.runtime.dispose()
    assert.equal(stream.isEnded(), true)
    assert.equal(harness.runtime.peek(conversation.id), null)
    assert.deepEqual(harness.runtime.running(), [])
    await waitFor(async () => (await assistantMessage(harness, conversation.id))?.status === "interrupted")
    const assistant = await assistantMessage(harness, conversation.id)
    assert.equal(assistant?.text, "未完成")
    harness.agent.finish()
})

test("保留轮次：最多保留 8 轮终态缓冲，更早的清理", async () => {
    const harness = createHarness()
    const ids: string[] = []
    for (let index = 0; index < 9; index += 1) {
        const conversation = await harness.store.create({ title: `会话 ${index}` })
        ids.push(conversation.id)
        const stream = await startTurn(harness, conversation.id)
        harness.agent.emit({ type: "session", sessionId: SESSION_ID })
        harness.agent.finish()
        await waitFor(() => stream.isEnded())
    }
    assert.equal(harness.runtime.peek(ids[0] ?? ""), null)
    assert.equal(ids.filter((id) => harness.runtime.peek(id) !== null).length, 8)
})

test("流式期间节流落盘：1 秒内事件合并写入，收尾立即写入", async () => {
    const harness = createHarness()
    const conversation = await harness.store.create()
    const stream = await startTurn(harness, conversation.id)
    harness.agent.emit({ type: "session", sessionId: SESSION_ID })
    harness.agent.emit({ type: "delta", text: "甲" })
    harness.agent.emit({ type: "delta", text: "乙" })
    // 节流窗口内不落盘：消息正文与块仍为空
    let assistant = await assistantMessage(harness, conversation.id)
    assert.equal(assistant?.text, "")
    assert.equal((assistant?.blocks ?? []).length, 0)
    assert.equal(assistant?.status, "streaming")

    harness.agent.finish()
    await waitFor(() => stream.isEnded())
    await waitFor(async () => (await assistantMessage(harness, conversation.id))?.status === "done")
    assistant = await assistantMessage(harness, conversation.id)
    assert.equal(assistant?.text, "甲乙")
})
