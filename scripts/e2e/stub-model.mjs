#!/usr/bin/env node
/*
 * OpenAI 兼容 stub 模型，e2e 专用
 *
 * 行为由用户消息里的标记决定，标记写在最后一条用户消息任意位置：
 *   [[stub:text]]          普通流式文本（缺省行为）
 *   [[stub:reasoning]]     先推 reasoning 再推正文
 *   [[stub:tool]]          execute_code(pwd) → 宿主执行后第二次请求回正文
 *   [[stub:tool-multi]]    同一响应里两个工具调用（pwd + 读 hello.txt）
 *   [[stub:tool-bad]]      调用不存在的工具（工具失败路径）
 *   [[stub:ask]]           内置 ask 工具提问，回答后回正文
 *   [[stub:approval]]      execute_code 请求 workspace-write 提权（审批路径）
 *   [[stub:steer]]         sleep 工具留出插话窗口，随后慢速正文
 *   [[stub:slow:300]]      慢速流，分块间隔毫秒（缺省 400）
 *   [[stub:500]]           HTTP 500
 *   [[stub:empty]]         空回复
 *   [[stub:error-mid]]     正文中途断开连接
 *   [[stub:markdown]]      Markdown 渲染素材
 *   [[stub:long]]          大量分块，供滚动与性能检查
 *
 * 控制接口：
 *   GET  /__stub/stats     请求、场景、中止、工具结果统计
 *   POST /__stub/reset     清零统计
 *   GET  /__stub/health    就绪检查
 */

import http from "node:http"
import fs from "node:fs"

const args = process.argv.slice(2)
const argValue = (name, fallback) => {
    const index = args.indexOf(`--${name}`)
    return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const HOST = process.env.STUB_HOST ?? "127.0.0.1"
const PORT = Number(process.env.STUB_PORT ?? process.env.PORT ?? argValue("port", "9790"))
const LOG_FILE = argValue("log", null)
const TEXT_DELAY = Number(argValue("text-delay", "12"))
const MODEL = "stub-1"
const CREATED = Math.floor(Date.now() / 1000)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* stderr 与文件双写，harness 失败时能取到 stub 视角 */
const log = (...parts) => {
    const line = `[stub] ${parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ")}`
    console.error(line)
    if (LOG_FILE !== null) {
        try {
            fs.appendFileSync(LOG_FILE, `${line}\n`)
        } catch {
            /* 日志写失败不影响服务 */
        }
    }
}

const EMPTY_STATS = () => ({
    startedAt: Date.now(),
    chatRequests: 0,
    completions: 0,
    aborted: 0,
    http500: 0,
    emptyReplies: 0,
    modelListRequests: 0,
    byScenario: {},
    toolResults: [],
    lastRequest: null,
    requestsLog: [],
})
let stats = EMPTY_STATS()

const TEXT_BY_SCENARIO = {
    text: "你好，我是测试模型。",
    reasoning: "推理完成，最终答案。",
    tool: "工具已执行完毕。",
    "tool-multi": "两个工具都执行完了。",
    "tool-bad": "工具失败路径结束。",
    ask: "收到回答，流程结束。",
    approval: "提权流程结束。",
    steer: "第一段回复已完成，插话内容已收到。",
    markdown: [
        "## 测试标题",
        "",
        "这是一段 **Markdown** 渲染素材，含 `行内代码` 与列表：",
        "",
        "- 第一项",
        "- 第二项",
        "",
        "```js",
        "const answer = 42",
        "```",
        "",
        "| 列一 | 列二 |",
        "| --- | --- |",
        "| a | b |",
        "",
        "链接：[示例](https://example.com)",
    ].join("\n"),
}

/* 消息内容可能是字符串或分段数组 */
const messageText = (message) => {
    if (typeof message?.content === "string") {
        return message.content
    }
    if (Array.isArray(message?.content)) {
        return message.content
            .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
            .join("")
    }
    return ""
}

const lastUserIndex = (messages) => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === "user") {
            return index
        }
    }
    return -1
}

const MARKER = /\[\[stub:([a-z0-9_-]+)(?::(\d+))?\]\]/i

function detectScenario(messages) {
    const index = lastUserIndex(messages)
    let foundIndex = index
    let text = index >= 0 ? messageText(messages[index]) : ""
    let match = MARKER.exec(text)
    /*
     * 插话会作为新 user 消息注入到工具结果之后。最后一条 user 没有标记时，
     * 往前找上一条带标记的 user，前提是中间已有 tool 消息（即仍在同一轮内）
     */
    if (match === null) {
        for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
            if (messages[cursor]?.role !== "user") {
                continue
            }
            const candidate = MARKER.exec(messageText(messages[cursor]))
            if (candidate === null) {
                continue
            }
            const hasToolBetween = messages
                .slice(cursor + 1)
                .some((message) => message?.role === "tool")
            if (!hasToolBetween) {
                break
            }
            foundIndex = cursor
            text = messageText(messages[cursor])
            match = candidate
            break
        }
    }
    const name = match === null ? "text" : match[1].toLowerCase()
    const param = match !== null && match[2] !== undefined ? Number(match[2]) : null
    return { name, param, lastUserIndex: foundIndex, userText: text }
}

/* 本条用户消息之后宿主已经执行过哪些工具（用于二次请求的判断） */
function progressAfter(messages, userIndex) {
    const after = userIndex >= 0 ? messages.slice(userIndex + 1) : messages
    const names = new Map()
    for (const message of messages) {
        if (Array.isArray(message?.tool_calls)) {
            for (const call of message.tool_calls) {
                if (call?.id !== undefined) {
                    names.set(call.id, call?.function?.name ?? "")
                }
            }
        }
    }
    const toolResults = after
        .filter((message) => message?.role === "tool")
        .map((message) => ({
            id: message.tool_call_id ?? null,
            name: names.get(message.tool_call_id) ?? null,
            content: messageText(message).slice(0, 2000),
        }))
    return { toolResults, hasToolResult: toolResults.length > 0 }
}

function sseHead(res) {
    res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
    })
}

function createEmitter(res) {
    const id = `chatcmpl-stub-${Date.now().toString(36)}`
    const state = { closed: false, ended: false }
    res.on("close", () => {
        if (!state.ended) {
            state.closed = true
            stats.aborted += 1
            log("客户端提前断开")
        }
    })
    const writeRaw = (payload) => {
        if (state.closed || state.ended || res.destroyed) {
            return false
        }
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
        return true
    }
    const chunk = (delta, finishReason = null) =>
        writeRaw({
            id,
            object: "chat.completion.chunk",
            created: CREATED,
            model: MODEL,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
        })
    return {
        get alive() {
            return !state.closed && !state.ended && !res.destroyed
        },
        chunk,
        finish(finishReason = "stop") {
            return chunk({}, finishReason)
        },
        usage(inputTokens = 32, outputTokens = 12) {
            return writeRaw({
                id,
                object: "chat.completion.chunk",
                created: CREATED,
                model: MODEL,
                choices: [],
                usage: {
                    prompt_tokens: inputTokens,
                    completion_tokens: outputTokens,
                    total_tokens: inputTokens + outputTokens,
                    prompt_tokens_details: { cached_tokens: 0 },
                    completion_tokens_details: { reasoning_tokens: 0 },
                },
            })
        },
        end() {
            if (state.closed || state.ended || res.destroyed) {
                state.ended = true
                return
            }
            res.write("data: [DONE]\n\n")
            res.end()
            state.ended = true
        },
        destroy() {
            res.destroy()
            state.ended = true
        },
    }
}

async function streamText(emitter, text, { interval = TEXT_DELAY, size = 4 } = {}) {
    for (let offset = 0; offset < text.length; offset += size) {
        if (!emitter.alive) {
            return false
        }
        if (!emitter.chunk({ content: text.slice(offset, offset + size) })) {
            return false
        }
        if (interval > 0) {
            await sleep(interval)
        }
    }
    return emitter.alive
}

/* 工具调用按 OpenAI 流式增量下发：首块带 id/name，参数分片 */
async function streamToolCalls(emitter, calls) {
    const first = calls.map((call, index) => ({
        index,
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: "" },
    }))
    emitter.chunk({ role: "assistant", tool_calls: first })
    for (let index = 0; index < calls.length; index += 1) {
        const raw = JSON.stringify(calls[index].args)
        const step = Math.max(1, Math.ceil(raw.length / 3))
        for (let offset = 0; offset < raw.length; offset += step) {
            if (!emitter.alive) {
                return false
            }
            emitter.chunk({ tool_calls: [{ index, function: { arguments: raw.slice(offset, offset + step) } }] })
            await sleep(5)
        }
    }
    emitter.finish("tool_calls")
    emitter.usage()
    emitter.end()
    return true
}

async function finishWithText(emitter, text, options = {}) {
    const completed = await streamText(emitter, text, options)
    if (!completed) {
        return
    }
    emitter.finish("stop")
    emitter.usage()
    emitter.end()
    stats.completions += 1
}

function toolCall(name, toolArgs, id = null) {
    return { id: id ?? `call_stub_${name}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1000)}`, name, args: toolArgs }
}

async function runScenario(emitter, scenario, progress, messages) {
    const name = scenario.name
    const interval = scenario.param === null ? TEXT_DELAY : Math.max(0, scenario.param)

    switch (name) {
        case "text":
        case "markdown": {
            const text = name === "markdown" ? TEXT_BY_SCENARIO.markdown : TEXT_BY_SCENARIO.text
            await finishWithText(emitter, text)
            return
        }
        case "long": {
            const lines = []
            for (let index = 1; index <= 120; index += 1) {
                lines.push(`第 ${index} 行：用来看滚动跟随与长列表渲染的占位内容。`)
            }
            await finishWithText(emitter, lines.join("\n"), { interval: 0, size: 64 })
            return
        }
        case "reasoning": {
            const thinking = ["先想一下：", "用户在测试推理增量。", "可以给出答案了。"]
            for (const part of thinking) {
                if (!emitter.alive) {
                    return
                }
                emitter.chunk({ reasoning_content: part })
                await sleep(30)
            }
            await finishWithText(emitter, TEXT_BY_SCENARIO.reasoning, { interval: 20 })
            return
        }
        case "tool": {
            if (!progress.hasToolResult) {
                await streamToolCalls(emitter, [toolCall("execute_code", { command: "pwd" })])
                return
            }
            recordToolResults(progress)
            await finishWithText(emitter, TEXT_BY_SCENARIO.tool, { interval: 20 })
            return
        }
        case "tool-multi": {
            if (!progress.hasToolResult) {
                await streamToolCalls(emitter, [
                    toolCall("execute_code", { command: "pwd" }),
                    toolCall("read", { file_path: "hello.txt" }),
                ])
                return
            }
            recordToolResults(progress)
            await finishWithText(emitter, TEXT_BY_SCENARIO["tool-multi"], { interval: 20 })
            return
        }
        case "tool-bad": {
            if (!progress.hasToolResult) {
                await streamToolCalls(emitter, [toolCall("no_such_tool", { foo: "bar" })])
                return
            }
            recordToolResults(progress)
            await finishWithText(emitter, TEXT_BY_SCENARIO["tool-bad"], { interval: 20 })
            return
        }
        case "ask": {
            if (!progress.hasToolResult) {
                await streamToolCalls(emitter, [
                    toolCall("ask", { question: "请选择测试选项", options: ["选项甲", "选项乙"] }),
                ])
                return
            }
            recordToolResults(progress)
            await finishWithText(emitter, TEXT_BY_SCENARIO.ask, { interval: 20 })
            return
        }
        case "approval": {
            if (!progress.hasToolResult) {
                await streamToolCalls(emitter, [
                    toolCall("execute_code", {
                        command: "pwd",
                        sandbox_permissions: "workspace-write",
                        justification: "测试提权审批",
                    }),
                ])
                return
            }
            recordToolResults(progress)
            await finishWithText(emitter, TEXT_BY_SCENARIO.approval, { interval: 20 })
            return
        }
        case "steer": {
            if (!progress.hasToolResult) {
                /* 慢工具给客户端留插话窗口，插话会在下一步模型调用前注入 */
                await streamToolCalls(emitter, [toolCall("execute_code", { command: "sleep 2" })])
                return
            }
            recordToolResults(progress)
            await finishWithText(emitter, TEXT_BY_SCENARIO.steer, { interval: Math.max(120, interval), size: 6 })
            return
        }
        case "slow": {
            const text = "这是一段慢速流式回复，用来测试停止、插话与断线续接。回复会分很多块，每块之间有间隔。"
            await finishWithText(emitter, text, { interval: Math.max(50, interval), size: 3 })
            return
        }
        case "empty": {
            stats.emptyReplies += 1
            emitter.finish("stop")
            emitter.usage()
            emitter.end()
            return
        }
        case "error-mid": {
            emitter.chunk({ content: "正文开始，" })
            await sleep(60)
            emitter.chunk({ content: "然后连接断开。" })
            await sleep(120)
            emitter.destroy()
            return
        }
        default: {
            log("未知场景，按普通文本处理", name, "消息数", messages.length)
            await finishWithText(emitter, TEXT_BY_SCENARIO.text)
        }
    }
}

function recordToolResults(progress) {
    for (const result of progress.toolResults) {
        stats.toolResults.push({ ...result, at: Date.now() })
    }
    if (progress.toolResults.length > 0) {
        log("收到工具结果", progress.toolResults.map((item) => item.name ?? "?").join(","))
    }
}

async function handleChat(req, res, body) {
    stats.chatRequests += 1
    let payload
    try {
        payload = JSON.parse(body)
    } catch {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: "body 不是合法 JSON", type: "invalid_request_error" } }))
        return
    }
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const scenario = detectScenario(messages)
    const progress = progressAfter(messages, scenario.lastUserIndex)
    stats.byScenario[scenario.name] = (stats.byScenario[scenario.name] ?? 0) + 1
    stats.lastRequest = {
        at: Date.now(),
        scenario: scenario.name,
        messageCount: messages.length,
        userText: scenario.userText.slice(0, 300),
        toolResults: progress.toolResults.length,
        tools: Array.isArray(payload.tools) ? payload.tools.length : 0,
    }
    stats.requestsLog.push(stats.lastRequest)
    if (stats.requestsLog.length > 80) {
        stats.requestsLog.shift()
    }
    log("请求", scenario.name, "消息", messages.length, "工具有结果", progress.toolResults.length)

    if (scenario.name === "500") {
        stats.http500 += 1
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: "stub 模型故意返回 500", type: "server_error", code: "stub_500" } }))
        return
    }

    /* 非流式请求给一个完整响应，便于 curl 调试 */
    if (payload.stream !== true) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
            JSON.stringify({
                id: `chatcmpl-stub-${Date.now().toString(36)}`,
                object: "chat.completion",
                created: CREATED,
                model: MODEL,
                choices: [
                    {
                        index: 0,
                        message: { role: "assistant", content: TEXT_BY_SCENARIO.text },
                        finish_reason: "stop",
                    },
                ],
                usage: { prompt_tokens: 32, completion_tokens: 12, total_tokens: 44 },
            }),
        )
        stats.completions += 1
        return
    }

    sseHead(res)
    const emitter = createEmitter(res)
    try {
        await runScenario(emitter, scenario, progress, messages)
    } catch (error) {
        log("场景执行异常", String(error))
        if (emitter.alive) {
            emitter.destroy()
        }
    }
}

function sendJson(res, status, value) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
    res.end(JSON.stringify(value))
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`)
    const path = url.pathname
    let body = ""
    try {
        for await (const chunk of req) {
            body += chunk
        }
    } catch {
        res.destroy()
        return
    }

    if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
        await handleChat(req, res, body)
        return
    }
    if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
        stats.modelListRequests += 1
        sendJson(res, 200, {
            object: "list",
            data: [
                { id: "stub-1", object: "model", created: CREATED, owned_by: "stub" },
                { id: "stub-reasoning", object: "model", created: CREATED, owned_by: "stub" },
                { id: "stub-slow", object: "model", created: CREATED, owned_by: "stub" },
            ],
        })
        return
    }
    if (req.method === "GET" && path === "/__stub/health") {
        sendJson(res, 200, { ok: true, port: PORT, scenarios: Object.keys(stats.byScenario) })
        return
    }
    if (req.method === "GET" && path === "/__stub/stats") {
        sendJson(res, 200, { ...stats, port: PORT })
        return
    }
    if (req.method === "POST" && path === "/__stub/reset") {
        stats = EMPTY_STATS()
        sendJson(res, 200, { ok: true })
        return
    }
    sendJson(res, 404, { error: "not found" })
})

server.listen(PORT, HOST, () => {
    log("监听", `http://${HOST}:${PORT}`, "场景标记形如 [[stub:tool]]")
})

const shutdown = () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 500)
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
