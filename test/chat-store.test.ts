import assert from "node:assert/strict"
import { test } from "node:test"

import type { StoredMessage } from "../src/chat-types.ts"
import {
    ChatStore,
    ChatStoreError,
    DEFAULT_CHAT_PERMISSION,
    DEFAULT_CHAT_TITLE,
} from "../src/chat-store.ts"
import type { ChatLogger, HostFileApiLike } from "../src/chat-store.ts"
import { MemoryFs } from "./helpers/memory-fs.ts"

interface WarningLog {
    readonly messages: string[]
    readonly logger: ChatLogger
}

function createLogger(): WarningLog {
    const messages: string[] = []
    const logger: ChatLogger = {
        warn(_data: unknown, message?: string) {
            messages.push(message ?? "")
        },
    }
    return { messages, logger }
}

/** MemoryFs 适配成 HostFileApiLike */
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

interface Harness {
    readonly store: ChatStore
    readonly memory: MemoryFs
    readonly logs: WarningLog
    readonly clock: { value: number }
}

function createHarness(limits?: ConstructorParameters<typeof ChatStore>[0]["limits"]): Harness {
    const memory = new MemoryFs()
    const logs = createLogger()
    const clock = { value: 1_000_000 }
    const store = new ChatStore({
        fs: createFileApi(memory),
        ...(limits === undefined ? {} : { limits }),
        logger: logs.logger,
        now: () => clock.value,
    })
    return { store, memory, logs, clock }
}

function userMessage(id: string, text: string, at = 1): StoredMessage {
    return { id, role: "user", at, text, blocks: [], status: "done" }
}

async function readJsonFile(memory: MemoryFs, path: string): Promise<Record<string, unknown>> {
    const text = await memory.text(path)
    assert.ok(text !== null, `文件存在：${path}`)
    return JSON.parse(text) as Record<string, unknown>
}

test("create：默认字段、id 规则与 chat/ 落盘位置", async () => {
    const { store, memory } = createHarness()
    await store.load()
    assert.deepEqual([...store.list()], [])
    assert.equal(store.activeId, null)

    const conversation = await store.create({ cwd: "/tmp/workspace" })
    assert.match(conversation.id, /^c[a-z0-9]{8,20}$/)
    assert.equal(conversation.v, 1)
    assert.equal(conversation.title, DEFAULT_CHAT_TITLE)
    assert.equal(conversation.permission, DEFAULT_CHAT_PERMISSION)
    assert.equal(conversation.cwd, "/tmp/workspace")
    assert.equal(conversation.sessionId, null)
    assert.deepEqual([...conversation.messages], [])

    const index = await readJsonFile(memory, "chat/index.json")
    assert.equal(index["v"], 1)
    assert.equal(index["activeId"], null)
    assert.equal((index["conversations"] as unknown[]).length, 1)

    const stored = await store.get(conversation.id)
    assert.equal(stored?.id, conversation.id)
    assert.equal(stored?.cwd, "/tmp/workspace")
    assert.equal(store.list()[0]?.id, conversation.id)
})

test("标题取首条用户消息首行，超过 32 字加省略号", async () => {
    const { store } = createHarness()
    const conversation = await store.create()
    const longLine = "一二三四五六七八九十".repeat(4)
    await store.mutate(conversation.id, (draft) => {
        draft.messages.push(userMessage("m1", `${longLine}\n第二行`))
    })
    const updated = await store.get(conversation.id)
    assert.equal(updated?.title, `${Array.from(longLine).slice(0, 32).join("")}…`)

    const plain = await store.create()
    await store.mutate(plain.id, (draft) => {
        draft.messages.push(userMessage("m1", "普通标题\n正文"))
    })
    assert.equal((await store.get(plain.id))?.title, "普通标题")
})

test("mutate：updatedAt 递增、摘要 last/usage/turns/steps 维护", async () => {
    const harness = createHarness()
    const { store, clock } = harness
    const conversation = await store.create()
    const createdAt = conversation.updatedAt

    clock.value += 1000
    const first = await store.mutate(conversation.id, (draft) => {
        draft.messages.push(userMessage("u1", "你好"))
        draft.messages.push({
            id: "a1",
            role: "assistant",
            at: clock.value,
            text: "",
            blocks: [{ type: "text", text: "回复正文" }],
            status: "streaming",
            startedAt: clock.value,
        })
    })
    assert.ok(first.updatedAt > createdAt)
    assert.equal(first.title, "你好")
    assert.equal(first.turns, 1)
    assert.equal(first.last?.role, "assistant")
    assert.equal(first.last?.status, "streaming")
    // 流式期间正文只维护块，摘要预览从正文块取
    assert.equal(first.last?.text, "回复正文")
    assert.equal(first.usage, null)

    clock.value += 1000
    const second = await store.mutate(conversation.id, (draft) => {
        const index = draft.messages.findIndex((item) => item.id === "a1")
        draft.messages[index] = {
            id: "a1",
            role: "assistant",
            at: createdAt,
            text: "回复正文",
            blocks: [{ type: "text", text: "回复正文" }],
            status: "done",
            usage: { inputTokens: 10, outputTokens: 20 },
            turn: 1,
            steps: 2,
            startedAt: createdAt,
            endedAt: clock.value,
        }
    })
    assert.ok(second.updatedAt > first.updatedAt)
    assert.deepEqual(second.usage, { inputTokens: 10, outputTokens: 20 })
    assert.equal(second.turns, 1)
    assert.equal(second.steps, 2)
    assert.equal(second.last?.status, "done")
})

test("列表按 updatedAt 倒序，setActive 持久化", async () => {
    const harness = createHarness()
    const { store, memory, clock } = harness
    const first = await store.create()
    clock.value += 1000
    const second = await store.create()
    clock.value += 1000
    await store.mutate(first.id, (draft) => {
        draft.messages.push(userMessage("u1", "让第一条变新"))
    })
    assert.deepEqual(
        store.list().map((item) => item.id),
        [first.id, second.id],
    )
    assert.equal(await store.setActive(second.id), second.id)
    assert.equal(store.activeId, second.id)

    const reloaded = new ChatStore({
        fs: createFileApi(memory),
        logger: createLogger().logger,
    })
    await reloaded.load()
    assert.equal(reloaded.activeId, second.id)
    assert.equal(reloaded.list().length, 2)
    assert.equal(await reloaded.setActive("c00000000"), second.id)
})

test("remove：删除文件、修正 activeId、未知 id 返回 false", async () => {
    const harness = createHarness()
    const { store, memory } = harness
    const first = await store.create()
    const second = await store.create()
    await store.setActive(first.id)
    assert.equal(await store.remove(first.id), true)
    assert.equal(await store.remove(first.id), false)
    assert.equal(store.activeId, second.id)
    assert.deepEqual(
        store.list().map((item) => item.id),
        [second.id],
    )
    assert.equal(await memory.stat(`chat/conversations/${first.id}.json`), null)
    const index = await readJsonFile(memory, "chat/index.json")
    assert.equal(index["activeId"], second.id)
})

test("会话数量超过上限时丢弃最早会话", async () => {
    const { store, memory, clock } = createHarness({ maxConversations: 3 })
    const created: string[] = []
    for (let index = 0; index < 4; index += 1) {
        clock.value += 1000
        const conversation = await store.create({ title: `会话 ${index}` })
        created.push(conversation.id)
    }
    assert.equal(store.list().length, 3)
    assert.deepEqual(
        store.list().map((item) => item.id),
        [...created.slice(1)].reverse(),
    )
    assert.equal(await memory.stat(`chat/conversations/${created[0]}.json`), null)
})

test("单会话字符超限时丢弃最早消息，单条消息截断", async () => {
    const { store } = createHarness({ maxConversationChars: 200, maxMessageChars: 100 })
    const conversation = await store.create()
    const long = "长".repeat(150)
    const updated = await store.mutate(conversation.id, (draft) => {
        for (let index = 0; index < 5; index += 1) {
            draft.messages.push(userMessage(`m${index}`, long))
        }
    })
    assert.equal(updated.messages.length, 2)
    assert.deepEqual(
        updated.messages.map((message) => message.id),
        ["m3", "m4"],
    )
    assert.equal(updated.messages[0]?.text.length, 100)
})

test("损坏的会话文件：读取返回 null 并 warning，其它会话不受影响", async () => {
    const harness = createHarness()
    const { store, memory, logs } = harness
    const broken = await store.create()
    const healthy = await store.create()
    memory.addFile(`chat/conversations/${broken.id}.json`, "{ 这不是 JSON")
    logs.messages.length = 0

    assert.equal(await store.get(broken.id), null)
    assert.ok(logs.messages.some((message) => message.includes("损坏")))
    assert.equal((await store.get(healthy.id))?.id, healthy.id)
    // 索引里的摘要仍在，列表不因单个损坏文件报错
    assert.equal(store.list().length, 2)
})

test("损坏的索引：按空索引处理，并从会话文件重建", async () => {
    const harness = createHarness()
    const { store, memory } = harness
    const conversation = await store.create({ title: "可恢复会话" })
    await store.mutate(conversation.id, (draft) => {
        draft.messages.push(userMessage("u1", "你好"))
    })
    memory.addFile("chat/index.json", "{bad index")

    const logs = createLogger()
    const rebuilt = new ChatStore({ fs: createFileApi(memory), logger: logs.logger })
    await rebuilt.load()
    assert.equal(rebuilt.list().length, 1)
    assert.equal(rebuilt.list()[0]?.id, conversation.id)
    assert.equal(rebuilt.activeId, conversation.id)
    assert.ok(logs.messages.some((message) => message.includes("索引")))
})

test("mutate：会话不存在或 id 非法时抛 ChatStoreError", async () => {
    const { store } = createHarness()
    await assert.rejects(
        store.mutate("c12345678", (draft) => {
            draft.title = "x"
        }),
        (error: unknown) => error instanceof ChatStoreError && error.code === "not-found",
    )
    await assert.rejects(
        store.mutate("bad-id", () => undefined),
        (error: unknown) => error instanceof ChatStoreError && error.code === "invalid",
    )
    assert.equal(await store.get("bad-id"), null)
})

test("并发写串行化：所有会话都落盘且索引一致", async () => {
    const { store, memory } = createHarness()
    const conversations = await Promise.all([
        store.create({ title: "a" }),
        store.create({ title: "b" }),
        store.create({ title: "c" }),
    ])
    await Promise.all(
        conversations.map((conversation, index) =>
            store.mutate(conversation.id, (draft) => {
                draft.messages.push(userMessage(`u${index}`, `内容 ${index}`))
            }),
        ),
    )
    assert.equal(store.list().length, 3)
    const index = await readJsonFile(memory, "chat/index.json")
    assert.equal((index["conversations"] as unknown[]).length, 3)
    for (const conversation of conversations) {
        const stored = await store.get(conversation.id)
        assert.equal(stored?.messages.length, 1)
    }
})

test("进程中断遗留的 streaming 消息：load 时改为 interrupted 并重写文件", async () => {
    const { store, memory } = createHarness()
    const conversation = await store.create()
    await store.mutate(conversation.id, (draft) => {
        draft.messages.push(userMessage("u1", "你好"))
        draft.messages.push({
            id: "a1",
            role: "assistant",
            at: 2,
            text: "",
            blocks: [{ type: "text", text: "没写完" }],
            status: "streaming",
            startedAt: 2,
        })
    })
    const indexBefore = await readJsonFile(memory, "chat/index.json")
    const summaryBefore = (indexBefore["conversations"] as Record<string, unknown>[])[0]
    assert.equal((summaryBefore?.["last"] as Record<string, unknown>)["status"], "streaming")

    const repaired = new ChatStore({ fs: createFileApi(memory), logger: createLogger().logger })
    await repaired.load()
    const stored = await repaired.get(conversation.id)
    assert.equal(stored?.messages[1]?.status, "interrupted")
    assert.equal(repaired.list()[0]?.last?.status, "interrupted")
    const indexAfter = await readJsonFile(memory, "chat/index.json")
    const summaryAfter = (indexAfter["conversations"] as Record<string, unknown>[])[0]
    assert.equal((summaryAfter?.["last"] as Record<string, unknown>)["status"], "interrupted")
})

test("load 幂等；损坏版本号的文件按跳过处理", async () => {
    const { store, memory } = createHarness()
    const conversation = await store.create()
    await store.mutate(conversation.id, (draft) => {
        draft.messages.push(userMessage("u1", "你好"))
    })
    const raw = await readJsonFile(memory, `chat/conversations/${conversation.id}.json`)
    memory.addFile(`chat/conversations/${conversation.id}.json`, JSON.stringify({ ...raw, v: 2 }))

    await store.load()
    await store.load()
    assert.equal(await store.get(conversation.id), null)
})
