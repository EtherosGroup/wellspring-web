#!/usr/bin/env node
/*
 * wellspring-web 0.4.0 端到端验证
 *
 * 一键运行：node scripts/e2e/run.mjs
 * 常用参数：
 *   --only S1,D1    只跑指定 id 前缀或名称包含的用例
 *   --no-browser    跳过浏览器检查
 *   --build-ui      运行前先 pnpm run build:ui 重建 www/
 *   --keep          结束后保留临时 home
 *   --no-clean      结束后保留临时 home（同 --keep）
 *   --report <file> 报告路径（默认 /tmp/e2e-report.md）
 *   --shots <dir>   截图目录（默认 /tmp/e2e-shots）
 *
 * 脚本只使用 Node 原生模块；不改业务代码，不做 git 提交。
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createHarness, DEFAULT_REPORT, DEFAULT_SHOTS_DIR, REPO_ROOT } from "./harness.mjs"
import {
    request,
    openSse,
    sleep,
    ok,
    eq,
    includes,
    isType,
    assertStatus,
    assertChineseError,
    buildReport,
    summarize,
} from "./lib.mjs"
import { runBrowserChecks } from "./browser.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"))
const EXPECTED_VERSION = PKG.version
/* 与 stub-model.mjs 的 slow 场景文本保持一致 */
const SLOW_TEXT =
    "这是一段慢速流式回复，用来测试停止、插话与断线续接。回复会分很多块，每块之间有间隔。"
const SLOW_SCENARIO_TEXT_STEER = "第一段回复已完成，插话内容已收到。"
const DEFAULT_MODEL_TEXT = "你好，我是测试模型。"

let harness = null
let state = {}
let runId = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19)

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
    const parsed = {
        only: null,
        keep: false,
        browser: true,
        clean: true,
        buildUi: false,
        report: DEFAULT_REPORT,
        shots: DEFAULT_SHOTS_DIR,
    }
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index]
        const value = () => argv[++index]
        switch (flag) {
            case "--only":
                parsed.only = (value() ?? "").split(",").map((item) => item.trim()).filter(Boolean)
                break
            case "--no-browser":
                parsed.browser = false
                break
            case "--build-ui":
                parsed.buildUi = true
                break
            case "--keep":
            case "--no-clean":
                parsed.keep = true
                parsed.clean = false
                break
            case "--report":
                parsed.report = value() ?? DEFAULT_REPORT
                break
            case "--shots":
                parsed.shots = value() ?? DEFAULT_SHOTS_DIR
                break
            case "--help":
            case "-h":
                printUsage()
                process.exit(0)
                break
            default:
                console.error(`未知参数：${flag}`)
        }
    }
    return parsed
}

function printUsage() {
    console.log("用法：node scripts/e2e/run.mjs [--only 用例id] [--no-browser] [--build-ui] [--keep] [--report file] [--shots dir]")
}

/* ------------------------------------------------------------------ */
/* 用例框架                                                            */
/* ------------------------------------------------------------------ */

const cases = []

function test(id, name, options, fn) {
    cases.push({
        id,
        name,
        fn,
        severity: options.severity ?? "P1",
        requiresApi: options.requiresApi !== false,
        timeoutMs: options.timeoutMs ?? 30_000,
        hint: options.hint,
        expectation: options.expectation,
        skip: options.skip,
        entry: options.entry ?? "direct",
    })
}

function createContext() {
    const streams = []
    const t = {
        harness,
        base: harness.webBase,
        gateway: harness.gatewayBase,
        workDir: harness.workDir,
        streams,
        get: (pathname, options = {}) => request(harness.webBase, pathname, options),
        post: (pathname, body, options = {}) => request(harness.webBase, pathname, { method: "POST", body, ...options }),
        patch: (pathname, body, options = {}) => request(harness.webBase, pathname, { method: "PATCH", body, ...options }),
        del: (pathname, options = {}) => request(harness.webBase, pathname, { method: "DELETE", ...options }),
        gatewayRequest: (pathname, options = {}) => request(harness.gatewayBase, pathname, options),
        async sse(pathname, options = {}) {
            const stream = await openSse(`${harness.webBase}${pathname}`, options)
            streams.push(stream)
            return stream
        },
        async chat(conversationId, body) {
            return await t.sse(`/api/conversations/${conversationId}/chat`, { method: "POST", body })
        },
        async gatewaySse(pathname, options = {}) {
            const stream = await openSse(`${harness.gatewayBase}${pathname}`, options)
            streams.push(stream)
            return stream
        },
        closeStreams() {
            for (const stream of streams) {
                stream.close()
            }
            streams.length = 0
        },
    }
    return t
}

function withTimeout(factory, timeoutMs, label) {
    let timer = null
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时（${timeoutMs}ms）`)), timeoutMs)
    })
    const run = Promise.resolve().then(factory)
    return Promise.race([run, timeout]).finally(() => clearTimeout(timer))
}

async function waitUntil(fn, { timeoutMs = 10_000, intervalMs = 200, label = "条件" } = {}) {
    const deadline = Date.now() + timeoutMs
    let lastError = null
    for (;;) {
        try {
            const value = await fn()
            if (value) {
                return value
            }
        } catch (error) {
            lastError = error
        }
        if (Date.now() >= deadline) {
            const detail = lastError === null ? "" : `（最后错误：${lastError instanceof Error ? lastError.message : String(lastError)}）`
            throw new Error(`${label}超时（${timeoutMs}ms）${detail}`)
        }
        await sleep(intervalMs)
    }
}

/* ------------------------------------------------------------------ */
/* 业务辅助                                                            */
/* ------------------------------------------------------------------ */

function assertConversationShape(conversation, label) {
    ok(conversation !== null && typeof conversation === "object", `${label}：响应缺少 conversation`)
    ok(/^c[a-z0-9]{8,20}$/.test(conversation.id ?? ""), `${label}：会话 id 格式不符（${conversation.id}）`)
    ok(typeof conversation.title === "string" && conversation.title !== "", `${label}：title 为空`)
    ok(typeof conversation.createdAt === "number", `${label}：createdAt 不是数字`)
    ok(typeof conversation.updatedAt === "number", `${label}：updatedAt 不是数字`)
    ok(Array.isArray(conversation.messages), `${label}：messages 不是数组`)
    ok(
        conversation.sessionId === null || typeof conversation.sessionId === "string",
        `${label}：sessionId 类型不符`,
    )
    ok(
        ["read-only", "workspace-write", "danger-full-access"].includes(conversation.permission),
        `${label}：permission 非法（${conversation.permission}）`,
    )
    ok(typeof conversation.turns === "number", `${label}：turns 不是数字`)
}

async function createConversation(t, extra = {}) {
    const response = await t.post("/api/conversations", {
        cwd: t.workDir,
        permission: "read-only",
        ...extra,
    })
    ok(
        response.status === 200 || response.status === 201,
        `新建会话失败 ${response.status}：${response.text.slice(0, 400)}`,
    )
    const conversation = response.json?.conversation
    assertConversationShape(conversation, "新建会话")
    return conversation
}

async function getConversation(t, id) {
    const response = await t.get(`/api/conversations/${id}`)
    assertStatus(response, 200, "读取会话")
    ok(response.json?.conversation !== undefined, "读取会话响应缺少 conversation")
    return response.json
}

async function chatToTerminal(t, conversationId, message, extra = {}) {
    const stream = await t.chat(conversationId, { message, ...extra })
    const terminal = await stream.collect({ timeoutMs: extra.timeoutMs ?? 90_000 })
    return { stream, terminal }
}

/** 从会话记录里取最后一条助手消息 */
function lastAssistant(conversation) {
    return conversation.messages.filter((message) => message.role === "assistant").at(-1) ?? null
}

function lastUser(conversation) {
    return conversation.messages.filter((message) => message.role === "user").at(-1) ?? null
}

/* ------------------------------------------------------------------ */
/* 用例：静态与健康                                                    */
/* ------------------------------------------------------------------ */

test(
    "S1",
    "健康检查 /__web/health",
    {
        severity: "P0",
        requiresApi: false,
        hint: "src/router.ts（或 index.ts）的 /__web/health 响应",
        expectation: "免登录 200，返回 {status:'ok', sso, user, version}",
    },
    async (t) => {
        const response = await t.get("/__web/health")
        assertStatus(response, 200, "健康检查")
        isType(response.json, "object", "健康检查响应")
        eq(response.json.status, "ok", "health.status")
        ok(typeof response.json.sso === "string" || response.json.sso === null, "health.sso 字段缺失")
        ok("user" in response.json, "health.user 字段缺失")
        ok(typeof response.json.version === "string" && response.json.version !== "", `health 缺少 version 字段（实际 ${response.text.slice(0, 200)}）`)
        eq(response.json.version, EXPECTED_VERSION, "health.version 与 package.json 版本")
    },
)

test(
    "S2",
    "静态首页与 CSP",
    {
        severity: "P0",
        requiresApi: false,
        hint: "src/static.ts、src/assets.ts、www/index.html",
        expectation: "GET / 返回 200 HTML；引用构建产物；{{theme}} 已替换；CSP 头存在",
    },
    async (t) => {
        const response = await t.get("/")
        assertStatus(response, 200, "静态首页")
        includes(response.headers["content-type"] ?? "", "text/html", "首页 content-type")
        includes(response.text.toLowerCase(), "<!doctype html", "首页 HTML")
        ok(!response.text.includes("{{theme}}"), "HTML 仍含 {{theme}} 主题占位符（主题注入未生效）")
        ok(/<script[^>]+src=/.test(response.text), "HTML 未引用构建产物脚本")
        includes(response.headers["content-security-policy"] ?? "", "default-src 'none'", "首页 CSP")
        includes(response.headers["content-security-policy"] ?? "", "script-src 'self'", "首页 CSP script-src")
        /* 抽取首个脚本资源并验证缓存头 */
        const match = /<script[^>]+src="([^"]+)"/.exec(response.text)
        if (match !== null && !match[1].startsWith("http")) {
            const assetPath = match[1].startsWith("/") ? match[1] : `/${match[1]}`
            const asset = await t.get(assetPath)
            assertStatus(asset, 200, `静态资源 ${assetPath}`)
        }
    },
)

test(
    "S3",
    "网关 /web 路由",
    {
        severity: "P0",
        requiresApi: false,
        entry: "gateway",
        hint: "index.ts 的网关注册、wellspring-gateway 配置",
        expectation: "网关 /web/__web/health 与 /web/ 均返回 200",
    },
    async (t) => {
        ok(harness.gatewayReady, "网关 /web 路由未注册（启动日志见报告尾部）")
        const health = await t.gatewayRequest("/web/__web/health")
        assertStatus(health, 200, "网关健康检查")
        eq(health.json?.status, "ok", "网关 health.status")
        const page = await t.gatewayRequest("/web/")
        assertStatus(page, 200, "网关首页")
        includes(page.headers["content-type"] ?? "", "text/html", "网关首页 content-type")
    },
)

test(
    "S4",
    "路径穿越与未知接口",
    {
        severity: "P1",
        requiresApi: false,
        hint: "src/static.ts 路径规范化、src/router.ts 404",
        expectation: "越界路径不泄露文件；未知 /api 路径返回 JSON 404",
    },
    async (t) => {
        const traversal = await t.get("/..%2f..%2f..%2fetc/passwd")
        ok(!(traversal.status === 200 && traversal.text.includes("root:")), "路径穿越泄露了 /etc/passwd")
        const unknown = await t.get("/api/definitely-not-exist")
        eq(unknown.status, 404, "未知 API 状态码")
    },
)

/* ------------------------------------------------------------------ */
/* 用例：bootstrap 与安全                                              */
/* ------------------------------------------------------------------ */

test(
    "B1",
    "GET /api/bootstrap 结构与数据",
    {
        severity: "P0",
        hint: "src/api/state.ts、src/chat-store.ts",
        expectation: "version/host/models/workspaces/conversations/activeId/running/limits 齐全，host.cwd 为隔离工作区",
    },
    async (t) => {
        const response = await t.get("/api/bootstrap")
        assertStatus(response, 200, "bootstrap")
        const data = response.json
        isType(data, "object", "bootstrap")
        eq(data.version, EXPECTED_VERSION, "bootstrap.version")
        isType(data.host, "object", "bootstrap.host")
        ok(typeof data.host.cwd === "string" && data.host.cwd !== "", "bootstrap.host.cwd 缺失")
        const realWorkDir = fs.realpathSync(t.workDir)
        ok(
            path.resolve(data.host.cwd) === realWorkDir || path.resolve(data.host.cwd) === t.workDir,
            `bootstrap.host.cwd 不是隔离工作区：${data.host.cwd}（期望 ${realWorkDir}）`,
        )
        ok(data.models !== null, "bootstrap.models 为 null（模型权限或配置未生效）")
        isType(data.models, "object", "bootstrap.models")
        ok(Array.isArray(data.models.providers), "bootstrap.models.providers 不是数组")
        ok(data.models.providers.some((provider) => provider.id === "stub"), "bootstrap.models 缺少 stub 供应商")
        ok(typeof data.models.activeProvider === "string", "bootstrap.models.activeProvider 缺失")
        ok(Array.isArray(data.workspaces), "bootstrap.workspaces 不是数组")
        ok(Array.isArray(data.conversations), "bootstrap.conversations 不是数组")
        ok(data.activeId === null || typeof data.activeId === "string", "bootstrap.activeId 类型不符")
        ok(Array.isArray(data.running), "bootstrap.running 不是数组")
        isType(data.limits, "object", "bootstrap.limits")
        for (const key of ["maxMessageChars", "maxReferences", "maxBodyBytes", "maxConversations", "maxConversationChars"]) {
            ok(typeof data.limits[key] === "number", `bootstrap.limits.${key} 缺失`)
        }
        ok(data.limits.maxMessageChars === 32_000, `limits.maxMessageChars 应为 32000（实际 ${data.limits.maxMessageChars}）`)
        state.bootstrap = data
    },
)

test(
    "B2",
    "经网关的 /api/bootstrap",
    {
        severity: "P1",
        entry: "gateway",
        hint: "网关路由 stripPrefix 与插件路由前缀",
        expectation: "http://网关/web/api/bootstrap 返回 200 且结构一致",
    },
    async (t) => {
        ok(harness.gatewayReady, "网关 /web 路由未注册")
        const response = await t.gatewayRequest("/web/api/bootstrap")
        assertStatus(response, 200, "网关 bootstrap")
        eq(response.json?.version, EXPECTED_VERSION, "网关 bootstrap.version")
    },
)

test(
    "B3",
    "安全响应头",
    {
        severity: "P1",
        hint: "src/security.ts 响应辅助",
        expectation: "/api/* 返回 nosniff、no-referrer、DENY",
    },
    async (t) => {
        const response = await t.get("/api/bootstrap")
        eq(response.headers["x-content-type-options"], "nosniff", "x-content-type-options")
        eq(response.headers["referrer-policy"], "no-referrer", "referrer-policy")
        eq(response.headers["x-frame-options"], "DENY", "x-frame-options")
    },
)

test(
    "B4",
    "未登录直连",
    {
        severity: "P1",
        hint: "src/session.ts / src/sso-client.ts",
        expectation: "网关开启鉴权时 /api/* 未登录返回 401；sso disabled 时跳过",
        skip: () => (harness.health?.sso === "disabled" ? "sso disabled，直连端口本就免登录" : null),
    },
    async (t) => {
        const response = await t.get("/api/bootstrap")
        eq(response.status, 401, "未登录 bootstrap 状态码")
    },
)

test(
    "B5",
    "CSRF：缺少 x-web-request 头",
    {
        severity: "P1",
        hint: "src/security.ts 写请求校验（x-web-request: 1）",
        expectation: "POST /api/conversations 无 x-web-request:1 时 403；只带旧头 x-wellspring-web 同样被拒",
    },
    async (t) => {
        const missing = await t.post("/api/conversations", { cwd: t.workDir }, { writeHeader: false })
        ok(missing.status === 400 || missing.status === 403, `缺少 CSRF 头仍返回 ${missing.status}`)
        assertChineseError(missing, "缺少 CSRF 头")
        const legacy = await t.post(
            "/api/conversations",
            { cwd: t.workDir },
            { headers: { "x-wellspring-web": "1" }, writeHeader: false },
        )
        ok(legacy.status === 400 || legacy.status === 403, `旧 CSRF 头仍返回 ${legacy.status}`)
        assertChineseError(legacy, "旧 CSRF 头")
    },
)

test(
    "B6",
    "CSRF：Origin 与 Host 不匹配",
    {
        severity: "P2",
        hint: "src/security.ts Origin 校验",
        expectation: "Origin 主机与请求 Host 不一致时拒绝",
    },
    async (t) => {
        const response = await t.post(
            "/api/conversations",
            { cwd: t.workDir },
            { headers: { origin: "http://evil.example" } },
        )
        ok(response.status === 400 || response.status === 403, `跨站 Origin 仍返回 ${response.status}`)
        assertChineseError(response, "Origin 校验")
        ok(response.json?.code === "cross-origin", `跨站 Origin 错误码不符：${response.json?.code}`)
    },
)

/* ------------------------------------------------------------------ */
/* 用例：经网关入口（写接口与 SSE）                                    */
/* ------------------------------------------------------------------ */

test(
    "W1",
    "经网关新建会话",
    {
        severity: "P0",
        entry: "gateway",
        hint: "wellspring-gateway 代理、src/router.ts 前缀处理、x-web-request 头",
        expectation: "网关 /web/api/conversations POST 返回 200，GET 可读",
    },
    async (t) => {
        ok(harness.gatewayReady, "网关 /web 路由未注册")
        const response = await request(harness.gatewayBase, "/web/api/conversations", {
            method: "POST",
            body: { cwd: t.workDir, permission: "read-only", title: "网关会话" },
        })
        ok(
            response.status === 200 || response.status === 201,
            `网关新建会话失败 ${response.status}：${response.text.slice(0, 400)}`,
        )
        const conversation = response.json?.conversation
        assertConversationShape(conversation, "网关新建会话")
        const detail = await request(harness.gatewayBase, `/web/api/conversations/${conversation.id}`)
        assertStatus(detail, 200, "网关读取会话")
        state.gatewayConversationId = conversation.id
    },
)

test(
    "W2",
    "经网关流式对话",
    {
        severity: "P0",
        entry: "gateway",
        timeoutMs: 90_000,
        hint: "网关 SSE 透传、src/api/chat.ts",
        expectation: "网关 /web 下 POST chat 收到 accepted/delta/done，会话记录完整",
    },
    async (t) => {
        ok(harness.gatewayReady, "网关 /web 路由未注册")
        let conversationId = state.gatewayConversationId
        if (typeof conversationId !== "string") {
            const created = await request(harness.gatewayBase, "/web/api/conversations", {
                method: "POST",
                body: { cwd: t.workDir, permission: "read-only" },
            })
            assertStatus(created, 200, "网关补建会话")
            conversationId = created.json?.conversation?.id
        }
        ok(typeof conversationId === "string", "网关会话 id 缺失")
        const stream = await t.gatewaySse(`/web/api/conversations/${conversationId}/chat`, {
            method: "POST",
            body: { message: "网关流式 [[stub:text]]" },
        })
        includes(stream.headers["content-type"] ?? "", "text/event-stream", "网关 chat content-type")
        await stream.waitType("accepted", { timeoutMs: 20_000 })
        const terminal = await stream.collect({ timeoutMs: 90_000 })
        eq(terminal.type, "done", `网关流式终态 ${terminal.type}`)
        eq(stream.deltaText(), DEFAULT_MODEL_TEXT, "网关流式正文")
        const detail = await request(harness.gatewayBase, `/web/api/conversations/${conversationId}`)
        assertStatus(detail, 200, "网关读取会话")
        eq(detail.json?.conversation?.messages?.length, 2, "网关会话消息数")
        state.gatewayStreamConversationId = conversationId
    },
)

test(
    "W3",
    "经网关停止",
    {
        severity: "P0",
        entry: "gateway",
        timeoutMs: 60_000,
        hint: "网关 POST stop、src/api/chat.ts、src/chat-runtime.ts",
        expectation: "网关入口 stop 返回 stopped=true，SSE 收到 stopped",
    },
    async (t) => {
        ok(harness.gatewayReady, "网关 /web 路由未注册")
        const created = await request(harness.gatewayBase, "/web/api/conversations", {
            method: "POST",
            body: { cwd: t.workDir, permission: "read-only" },
        })
        assertStatus(created, 200, "网关停止用例建会话")
        const conversationId = created.json?.conversation?.id
        const stream = await t.gatewaySse(`/web/api/conversations/${conversationId}/chat`, {
            method: "POST",
            body: { message: "网关慢流 [[stub:slow:250]]" },
        })
        await stream.waitFor((event) => event.type === "delta", { timeoutMs: 20_000, label: "网关首个 delta" })
        const stop = await request(harness.gatewayBase, `/web/api/conversations/${conversationId}/stop`, {
            method: "POST",
            body: {},
        })
        assertStatus(stop, 200, "网关停止")
        eq(stop.json?.stopped, true, "网关 stop.stopped")
        const terminal = await stream.collect({ timeoutMs: 30_000 })
        eq(terminal.type, "stopped", `网关停止终态 ${terminal.type}`)
    },
)

test(
    "W4",
    "经网关插话",
    {
        severity: "P1",
        entry: "gateway",
        timeoutMs: 60_000,
        hint: "网关 POST interject、SSE steer 事件",
        expectation: "网关入口插话 accepted=true，SSE 收到 steer，最终 done",
    },
    async (t) => {
        ok(harness.gatewayReady, "网关 /web 路由未注册")
        const created = await request(harness.gatewayBase, "/web/api/conversations", {
            method: "POST",
            body: { cwd: t.workDir, permission: "read-only" },
        })
        assertStatus(created, 200, "网关插话建会话")
        const conversationId = created.json?.conversation?.id
        const stream = await t.gatewaySse(`/web/api/conversations/${conversationId}/chat`, {
            method: "POST",
            body: { message: "网关插话 [[stub:steer]]" },
        })
        await stream.waitFor((event) => event.type === "tool" && event.phase === "start", {
            timeoutMs: 20_000,
            label: "网关工具 start",
        })
        const interject = await request(harness.gatewayBase, `/web/api/conversations/${conversationId}/interject`, {
            method: "POST",
            body: { message: "网关入口插话" },
        })
        assertStatus(interject, 200, "网关插话")
        eq(interject.json?.accepted, true, "网关 interject.accepted")
        await stream.waitFor((event) => event.type === "steer", { timeoutMs: 30_000, label: "网关 steer 事件" })
        const terminal = await stream.collect({ timeoutMs: 60_000 })
        eq(terminal.type, "done", `网关插话终态 ${terminal.type}`)
    },
)

test(
    "W5",
    "经网关 ask 应答",
    {
        severity: "P1",
        entry: "gateway",
        timeoutMs: 120_000,
        hint: "网关 POST /web/api/asks/:id、SSE ask 事件",
        expectation: "网关入口收到 ask 事件，POST 应答后宿主继续到 done",
    },
    async (t) => {
        ok(harness.gatewayReady, "网关 /web 路由未注册")
        const created = await request(harness.gatewayBase, "/web/api/conversations", {
            method: "POST",
            body: { cwd: t.workDir, permission: "read-only" },
        })
        assertStatus(created, 200, "网关 ask 建会话")
        const conversationId = created.json?.conversation?.id
        const stream = await t.gatewaySse(`/web/api/conversations/${conversationId}/chat`, {
            method: "POST",
            body: { message: "网关提问 [[stub:ask]]" },
        })
        const ask = await stream.waitFor((event) => event.type === "ask" && event.request !== null, {
            timeoutMs: 30_000,
            label: "网关 ask 事件",
        })
        const answer = await request(
            harness.gatewayBase,
            `/web/api/asks/${encodeURIComponent(ask.request.askId)}`,
            { method: "POST", body: { answer: "选项甲" } },
        )
        assertStatus(answer, 200, "网关应答 ask")
        eq(answer.json?.accepted, true, "网关 ask accepted")
        const terminal = await stream.collect({ timeoutMs: 90_000 })
        eq(terminal.type, "done", `网关 ask 终态 ${terminal.type}`)
        eq(terminal.reply, "收到回答，流程结束。", "网关 ask 后续正文")
    },
)

test(
    "W6",
    "经网关 approval 应答",
    {
        severity: "P1",
        entry: "gateway",
        timeoutMs: 120_000,
        hint: "网关 POST /web/api/approvals/:id、SSE approval 事件",
        expectation: "网关入口收到 approval 事件，批准后工具成功并 done",
    },
    async (t) => {
        ok(harness.gatewayReady, "网关 /web 路由未注册")
        const created = await request(harness.gatewayBase, "/web/api/conversations", {
            method: "POST",
            body: { cwd: t.workDir, permission: "read-only" },
        })
        assertStatus(created, 200, "网关审批建会话")
        const conversationId = created.json?.conversation?.id
        const stream = await t.gatewaySse(`/web/api/conversations/${conversationId}/chat`, {
            method: "POST",
            body: { message: "网关提权 [[stub:approval]]" },
        })
        const approval = await stream.waitFor((event) => event.type === "approval" && event.request !== null, {
            timeoutMs: 30_000,
            label: "网关 approval 事件",
        })
        const answer = await request(
            harness.gatewayBase,
            `/web/api/approvals/${encodeURIComponent(approval.request.approvalId)}`,
            { method: "POST", body: { approved: true } },
        )
        assertStatus(answer, 200, "网关应答 approval")
        eq(answer.json?.accepted, true, "网关 approval accepted")
        const terminal = await stream.collect({ timeoutMs: 90_000 })
        eq(terminal.type, "done", `网关 approval 终态 ${terminal.type}`)
        const end = stream.all("tool").find((event) => event.phase === "end")
        eq(end?.ok, true, "网关审批后工具 end.ok")
    },
)

test(
    "W7",
    "经网关断线续接",
    {
        severity: "P1",
        entry: "gateway",
        timeoutMs: 120_000,
        hint: "网关 GET /web/api/conversations/:id/resume SSE",
        expectation: "网关入口断开后 peek 与 resume 均可用，续接拿到完整正文与 done",
    },
    async (t) => {
        ok(harness.gatewayReady, "网关 /web 路由未注册")
        const created = await request(harness.gatewayBase, "/web/api/conversations", {
            method: "POST",
            body: { cwd: t.workDir, permission: "read-only" },
        })
        assertStatus(created, 200, "网关续接建会话")
        const conversationId = created.json?.conversation?.id
        const stream = await t.gatewaySse(`/web/api/conversations/${conversationId}/chat`, {
            method: "POST",
            body: { message: "网关续接 [[stub:slow:250]]" },
        })
        await waitUntil(async () => stream.all("delta").length >= 3, {
            timeoutMs: 20_000,
            label: "网关续接收到 3 个增量",
        })
        const since = stream.received
        stream.close()
        await sleep(300)
        const peek = await request(
            harness.gatewayBase,
            `/web/api/conversations/${conversationId}/resume?since=${since}&peek=1`,
        )
        assertStatus(peek, 200, "网关 peek")
        eq(peek.json?.active, true, "网关 peek.active")
        const resumed = await t.gatewaySse(`/web/api/conversations/${conversationId}/resume?since=${since}`)
        await resumed.waitType("resume", { timeoutMs: 20_000 })
        const terminal = await resumed.collect({ timeoutMs: 90_000 })
        eq(terminal.type, "done", `网关续接终态 ${terminal.type}`)
        eq(stream.deltaText() + resumed.deltaText(), SLOW_TEXT, "网关续接拼接正文")
    },
)

/* ------------------------------------------------------------------ */
/* 用例：会话 CRUD                                                     */
/* ------------------------------------------------------------------ */

test(
    "C1",
    "新建会话",
    {
        severity: "P0",
        hint: "src/api/conversations.ts、src/chat-store.ts",
        expectation: "POST /api/conversations 返回会话记录，GET /api/conversations/:id 可读且 running=false",
    },
    async (t) => {
        const created = await createConversation(t, { title: "E2E 新建会话" })
        eq(created.title, "E2E 新建会话", "会话标题")
        eq(created.cwd, fs.realpathSync(t.workDir), "会话 cwd")
        const detail = await getConversation(t, created.id)
        eq(detail.running, false, "新会话 running")
        eq(detail.conversation.messages.length, 0, "新会话消息数")
        state.crudConversationId = created.id
    },
)

test(
    "C2",
    "会话列表与 active",
    {
        severity: "P1",
        hint: "src/chat-store.ts index.json、src/api/conversations.ts",
        expectation: "列表包含新会话；POST active 后 bootstrap.activeId 指向它",
    },
    async (t) => {
        const id = state.crudConversationId
        ok(typeof id === "string", "前置 C1 未创建会话")
        const list = await t.get("/api/conversations")
        assertStatus(list, 200, "会话列表")
        ok(Array.isArray(list.json?.conversations), "conversations 不是数组")
        ok(list.json.conversations.some((item) => item.id === id), "列表里没有刚创建的会话")
        const active = await t.post(`/api/conversations/${id}/active`)
        assertStatus(active, 200, "设置 active")
        eq(active.json?.activeId, id, "activeId")
        const bootstrap = await t.get("/api/bootstrap")
        eq(bootstrap.json?.activeId, id, "bootstrap.activeId")
    },
)

test(
    "C3",
    "会话改名",
    {
        severity: "P1",
        hint: "src/api/conversations.ts PATCH",
        expectation: "PATCH 后 title 更新、updatedAt 不回退",
    },
    async (t) => {
        const id = state.crudConversationId
        const before = await getConversation(t, id)
        const response = await t.patch(`/api/conversations/${id}`, { title: "改名后的会话" })
        assertStatus(response, 200, "会话改名")
        eq(response.json?.conversation?.title, "改名后的会话", "改名结果")
        ok(
            response.json.conversation.updatedAt >= before.conversation.updatedAt,
            "updatedAt 回退",
        )
    },
)

test(
    "C4",
    "删除会话",
    {
        severity: "P1",
        hint: "src/api/conversations.ts DELETE、src/chat-store.ts",
        expectation: "DELETE 返回 ok；随后 GET 404；列表不再包含",
    },
    async (t) => {
        const created = await createConversation(t, { title: "待删除会话" })
        const response = await t.del(`/api/conversations/${created.id}`)
        assertStatus(response, 200, "删除会话")
        const detail = await t.get(`/api/conversations/${created.id}`)
        eq(detail.status, 404, "删除后读取状态码")
        const list = await t.get("/api/conversations")
        ok(!list.json.conversations.some((item) => item.id === created.id), "列表仍包含已删除会话")
    },
)

test(
    "C5",
    "读取不存在的会话",
    {
        severity: "P2",
        hint: "src/api/conversations.ts",
        expectation: "404 且错误信息为中文",
    },
    async (t) => {
        const response = await t.get("/api/conversations/c00000000")
        eq(response.status, 404, "不存在会话状态码")
        assertChineseError(response, "不存在会话")
    },
)

test(
    "C6",
    "坏工作区创建会话",
    {
        severity: "P1",
        hint: "src/api/conversations.ts 工作区校验、chat-runtime 错误映射",
        expectation: "不存在的 cwd 返回 4xx 中文错误，不能创建出坏会话",
    },
    async (t) => {
        const response = await t.post("/api/conversations", { cwd: "/definitely-not-exist-e2e" })
        if (response.status >= 400 && response.status < 500) {
            assertChineseError(response, "坏工作区")
            return
        }
        /* 允许把工作区校验延后到发消息：chat 流必须给出中文错误 */
        eq(response.status, 200, "坏工作区创建状态码")
        const conversation = response.json?.conversation
        assertConversationShape(conversation, "坏工作区创建")
        const stream = await t.chat(conversation.id, { message: "坏工作区 [[stub:text]]" })
        const terminal = await stream.collect({ timeoutMs: 30_000 })
        eq(terminal.type, "error", `坏工作区终态 ${terminal.type}`)
        ok(
            /[\u4e00-\u9fff]/.test(String(terminal.error ?? "")) && /工作区|不可用/.test(String(terminal.error ?? "")),
            `坏工作区错误信息不符：${terminal.error}`,
        )
    },
)

/* ------------------------------------------------------------------ */
/* 用例：对话流与持久化                                                */
/* ------------------------------------------------------------------ */

test(
    "D1",
    "流式对话 accepted/session/delta/done",
    {
        severity: "P0",
        timeoutMs: 60_000,
        hint: "src/api/chat.ts、src/chat-runtime.ts",
        expectation: "收到 accepted（消息 id）、session（宿主会话 id）、delta 拼接=回复、done；GET 会话含完整两条消息",
    },
    async (t) => {
        const conversation = await createConversation(t, { title: "E2E 普通对话" })
        const stream = await t.chat(conversation.id, { message: "你好 [[stub:text]]" })
        includes(stream.headers["content-type"] ?? "", "text/event-stream", "chat content-type")
        const accepted = await stream.waitType("accepted", { timeoutMs: 15_000 })
        eq(accepted.conversationId, conversation.id, "accepted.conversationId")
        ok(typeof accepted.userMessageId === "string" && accepted.userMessageId !== "", "accepted.userMessageId 缺失")
        ok(
            typeof accepted.assistantMessageId === "string" && accepted.assistantMessageId !== "",
            "accepted.assistantMessageId 缺失",
        )
        const sessionEvent = await stream.waitType("session", { timeoutMs: 15_000 })
        ok(
            /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(sessionEvent.sessionId ?? ""),
            `宿主 sessionId 格式不符：${sessionEvent.sessionId}`,
        )
        const terminal = await stream.collect({ timeoutMs: 60_000 })
        eq(terminal.type, "done", `终态事件为 ${terminal.type}：${JSON.stringify(terminal).slice(0, 300)}`)
        eq(terminal.reply, DEFAULT_MODEL_TEXT, "done.reply")
        eq(terminal.sessionId, sessionEvent.sessionId, "done.sessionId")
        eq(stream.deltaText(), DEFAULT_MODEL_TEXT, "delta 拼接正文")
        ok(terminal.turn === 1, `done.turn 应为 1（实际 ${terminal.turn}）`)
        ok(terminal.usage === null || typeof terminal.usage === "object", "done.usage 类型不符")
        const detail = await getConversation(t, conversation.id)
        eq(detail.running, false, "对话结束后 running")
        assertConversationShape(detail.conversation, "对话结束")
        eq(detail.conversation.messages.length, 2, "消息数")
        const assistant = lastAssistant(detail.conversation)
        eq(assistant.status, "done", "助手消息状态")
        eq(assistant.text, DEFAULT_MODEL_TEXT, "助手消息正文")
        ok(Array.isArray(assistant.blocks) && assistant.blocks.some((block) => block.type === "text"), "助手消息缺少 text 块")
        eq(detail.conversation.sessionId, sessionEvent.sessionId, "会话记录 sessionId")
        state.normalConversationId = conversation.id
        state.normalSessionId = sessionEvent.sessionId
    },
)

test(
    "D2",
    "SSE 响应头",
    {
        severity: "P1",
        hint: "src/api/chat.ts",
        expectation: "cache-control: no-store、x-accel-buffering: no",
    },
    async (t) => {
        const conversation = await createConversation(t)
        const stream = await t.chat(conversation.id, { message: "头测试 [[stub:text]]" })
        includes(stream.headers["cache-control"] ?? "", "no-store", "cache-control")
        eq(stream.headers["x-accel-buffering"], "no", "x-accel-buffering")
        await stream.collect({ timeoutMs: 30_000 })
    },
)

test(
    "D3",
    "空消息被拒绝",
    {
        severity: "P1",
        hint: "src/api/chat.ts 请求体校验",
        expectation: "message 去空白后为空时 4xx 中文错误",
    },
    async (t) => {
        const conversation = await createConversation(t)
        const response = await t.post(`/api/conversations/${conversation.id}/chat`, { message: "   " })
        ok(response.status >= 400 && response.status < 500, `空消息返回 ${response.status}`)
        assertChineseError(response, "空消息")
    },
)

test(
    "D4",
    "超长消息被拒绝",
    {
        severity: "P1",
        hint: "src/security.ts 请求体上限、src/api/chat.ts 消息长度校验",
        expectation: "超过 32000 字符返回 4xx 中文错误",
    },
    async (t) => {
        const conversation = await createConversation(t)
        const response = await t.post(`/api/conversations/${conversation.id}/chat`, { message: "a".repeat(32_001) })
        ok(response.status >= 400 && response.status < 500, `超长消息返回 ${response.status}`)
        assertChineseError(response, "超长消息")
    },
)

test(
    "D5",
    "思考增量 reasoning",
    {
        severity: "P1",
        timeoutMs: 60_000,
        hint: "src/chat-runtime.ts reasoning 事件与 StoredMessage.blocks",
        expectation: "收到 reasoning 增量；done 正常；会话块里保留 reasoning 块",
    },
    async (t) => {
        const conversation = await createConversation(t)
        const stream = await t.chat(conversation.id, { message: "推理测试 [[stub:reasoning]]" })
        const reasoning = await stream.waitFor((event) => event.type === "reasoning" && (event.text ?? "") !== "", {
            timeoutMs: 20_000,
            label: "reasoning 事件",
        })
        ok(typeof reasoning.text === "string" && reasoning.text.length > 0, "reasoning.text 为空")
        const terminal = await stream.collect({ timeoutMs: 60_000 })
        eq(terminal.type, "done", `reasoning 场景终态 ${terminal.type}`)
        const detail = await getConversation(t, conversation.id)
        const assistant = lastAssistant(detail.conversation)
        ok(
            assistant.blocks.some((block) => block.type === "reasoning" && (block.text ?? "") !== ""),
            "会话记录缺少 reasoning 块",
        )
        eq(assistant.text, "推理完成，最终答案。", "reasoning 场景正文")
    },
)

test(
    "D6",
    "Markdown 正文",
    {
        severity: "P2",
        timeoutMs: 60_000,
        hint: "src/chat-runtime.ts delta 拼接",
        expectation: "多行 Markdown 文本无损拼接进 done.reply 与会话记录",
    },
    async (t) => {
        const conversation = await createConversation(t)
        const stream = await t.chat(conversation.id, { message: "渲染素材 [[stub:markdown]]" })
        const terminal = await stream.collect({ timeoutMs: 60_000 })
        eq(terminal.type, "done", `markdown 场景终态 ${terminal.type}`)
        includes(terminal.reply, "## 测试标题", "markdown 正文")
        includes(terminal.reply, "const answer = 42", "markdown 代码块")
        const detail = await getConversation(t, conversation.id)
        eq(lastAssistant(detail.conversation).text, terminal.reply, "会话记录正文与 done.reply")
    },
)

test(
    "D7",
    "同一会话第二轮",
    {
        severity: "P1",
        timeoutMs: 60_000,
        hint: "src/chat-runtime.ts 会话复用 sessionId/cwd",
        expectation: "第二轮 done.turn=2、sessionId 不变、消息累计为 4 条",
    },
    async (t) => {
        const id = state.normalConversationId
        ok(typeof id === "string", "前置 D1 未完成")
        const stream = await t.chat(id, { message: "继续 [[stub:text]]" })
        const sessionEvent = await stream.waitType("session", { timeoutMs: 20_000 })
        eq(sessionEvent.sessionId, state.normalSessionId, "第二轮 sessionId")
        const terminal = await stream.collect({ timeoutMs: 60_000 })
        eq(terminal.type, "done", `第二轮终态 ${terminal.type}`)
        eq(terminal.turn, 2, "第二轮 done.turn")
        const detail = await getConversation(t, id)
        eq(detail.conversation.messages.length, 4, "两轮后消息数")
        ok(detail.conversation.turns >= 2, "会话 turns 未累计")
    },
)

test(
    "D8",
    "同一会话并发发消息返回 409",
    {
        severity: "P1",
        timeoutMs: 45_000,
        hint: "src/api/chat.ts 并发保护",
        expectation: "一轮进行中再 POST chat 返回 409 中文错误；随后 stop 收尾",
    },
    async (t) => {
        const conversation = await createConversation(t)
        const stream = await t.chat(conversation.id, { message: "慢流 [[stub:slow:200]]" })
        await stream.waitFor((event) => event.type === "delta", { timeoutMs: 20_000, label: "首个 delta" })
        const concurrent = await t.post(`/api/conversations/${conversation.id}/chat`, { message: "并发第二条" })
        eq(concurrent.status, 409, "并发 chat 状态码")
        assertChineseError(concurrent, "并发 chat")
        const stop = await t.post(`/api/conversations/${conversation.id}/stop`)
        eq(stop.status, 200, "并发测试 stop")
        await stream.collect({ timeoutMs: 20_000 })
    },
)

test(
    "D9",
    "运行态 /api/running 与 conversation.running",
    {
        severity: "P1",
        timeoutMs: 45_000,
        hint: "src/api/conversations.ts running、src/chat-runtime.ts 运行表",
        expectation: "流式中 running 列表含会话、GET 会话 running=true；stop 后消失",
    },
    async (t) => {
        const conversation = await createConversation(t)
        const stream = await t.chat(conversation.id, { message: "运行态 [[stub:slow:200]]" })
        await stream.waitFor((event) => event.type === "delta", { timeoutMs: 20_000, label: "首个 delta" })
        const running = await t.get("/api/running")
        assertStatus(running, 200, "running 列表")
        ok(Array.isArray(running.json?.running), "running 不是数组")
        ok(
            running.json.running.some((item) => item.conversationId === conversation.id),
            `running 列表不含 ${conversation.id}`,
        )
        const detail = await getConversation(t, conversation.id)
        eq(detail.running, true, "运行中 conversation.running")
        await t.post(`/api/conversations/${conversation.id}/stop`)
        await stream.collect({ timeoutMs: 20_000 })
        await waitUntil(
            async () => {
                const list = await t.get("/api/running")
                return !(list.json?.running ?? []).some((item) => item.conversationId === conversation.id)
            },
            { timeoutMs: 10_000, label: "running 列表移除已停止会话" },
        )
    },
)

/* ------------------------------------------------------------------ */
/* 用例：工具调用                                                      */
/* ------------------------------------------------------------------ */

test(
    "E1",
    "工具调用 start/end",
    {
        severity: "P0",
        timeoutMs: 90_000,
        hint: "src/chat-runtime.ts tool 事件、宿主工具执行",
        expectation: "同一工具 id 先 start 后 end，ok=true，会话记录有已完成 tool 块",
    },
    async (t) => {
        const conversation = await createConversation(t)
        const stream = await t.chat(conversation.id, { message: "执行命令 [[stub:tool]]" })
        const start = await stream.waitFor(
            (event) => event.type === "tool" && event.phase === "start",
            { timeoutMs: 30_000, label: "tool start 事件" },
        )
        eq(start.name, "execute_code", "tool.start.name")
        ok(typeof start.arguments === "string" && start.arguments.includes("pwd"), "tool.start.arguments")
        const end = await stream.waitFor(
            (event) => event.type === "tool" && event.phase === "end" && event.id === start.id,
            { timeoutMs: 60_000, label: "tool end 事件" },
        )
        eq(end.ok, true, "tool.end.ok")
        ok(typeof end.result === "string" && end.result.length > 0, "tool.end.result 为空")
        const terminal = await stream.collect({ timeoutMs: 60_000 })
        eq(terminal.type, "done", `工具场景终态 ${terminal.type}`)
        const detail = await getConversation(t, conversation.id)
        const assistant = lastAssistant(detail.conversation)
        const toolBlock = assistant.blocks.find((block) => block.type === "tool" && block.id === start.id)
        ok(toolBlock !== undefined, "会话记录缺少 tool 块")
        eq(toolBlock.status, "ok", "tool 块状态")
        ok(toolBlock.endedAt !== null, "tool 块 endedAt 为空")
    },
)

test(
    "E2",
    "多个工具调用",
    {
        severity: "P1",
        timeoutMs: 90_000,
        hint: "src/chat-runtime.ts 工具事件按 id 合并",
        expectation: "同一轮两个工具各自 start/end，会话记录两个 ok 块",
    },
    async (t) => {
        const conversation = await createConversation(t)
        const stream = await t.chat(conversation.id, { message: "多工具 [[stub:tool-multi]]" })
        await stream.waitFor((event) => event.type === "tool" && event.phase === "end", {
            timeoutMs: 60_000,
            label: "第二个工具 end",
        })
        const terminal = await stream.collect({ timeoutMs: 60_000 })
        eq(terminal.type, "done", `多工具终态 ${terminal.type}`)
        const tools = stream.all("tool")
        const starts = tools.filter((event) => event.phase === "start")
        const ends = tools.filter((event) => event.phase === "end")
        ok(starts.length >= 2, `工具 start 数不足：${starts.length}`)
        ok(ends.length >= 2, `工具 end 数不足：${ends.length}`)
        ok(ends.every((event) => event.ok === true), "存在失败的工具 end")
        ok(new Set(starts.map((event) => event.id)).size >= 2, "工具 id 未区分")
        const detail = await getConversation(t, conversation.id)
        const blocks = lastAssistant(detail.conversation).blocks.filter((block) => block.type === "tool")
        ok(blocks.length >= 2, `会话记录 tool 块不足：${blocks.length}`)
        ok(blocks.every((block) => block.status === "ok"), "存在非 ok 的 tool 块")
    },
)

test(
    "E3",
    "工具失败事件",
    {
        severity: "P2",
        timeoutMs: 90_000,
        hint: "src/chat-runtime.ts tool end 失败映射",
        expectation: "未知工具 end.ok=false 且结果含中文说明，轮次仍以 done 收尾",
    },
    async (t) => {
        const conversation = await createConversation(t)
        const stream = await t.chat(conversation.id, { message: "坏工具 [[stub:tool-bad]]" })
        const end = await stream.waitFor(
            (event) => event.type === "tool" && event.phase === "end",
            { timeoutMs: 60_000, label: "失败工具 end" },
        )
        eq(end.ok, false, "失败工具 end.ok")
        includes(end.result ?? "", "未知工具", "失败工具结果")
        const terminal = await stream.collect({ timeoutMs: 60_000 })
        eq(terminal.type, "done", `坏工具终态 ${terminal.type}`)
        const detail = await getConversation(t, conversation.id)
        const block = lastAssistant(detail.conversation).blocks.find((item) => item.type === "tool")
        eq(block?.status, "error", "失败工具块状态")
    },
)

/* ------------------------------------------------------------------ */
/* 用例：提问                                                          */
/* ------------------------------------------------------------------ */

test(
    "F1",
    "ask 提问与应答",
    {
        severity: "P0",
        timeoutMs: 120_000,
        hint: "src/chat-runtime.ts ask 事件、src/api/answers.ts、宿主 respondAsk",
        expectation: "收到 ask.request；POST /api/asks/:id 后宿主继续并 done；会话记录 answer",
    },
    async (t) => {
        const conversation = await createConversation(t)
        const stream = await t.chat(conversation.id, { message: "问我 [[stub:ask]]" })
        const ask = await stream.waitFor((event) => event.type === "ask" && event.request !== null, {
            timeoutMs: 30_000,
            label: "ask 事件",
        })
        const request = ask.request
        ok(typeof request.askId === "string" && request.askId !== "", "ask.askId 缺失")
        eq(request.question, "请选择测试选项", "ask.question")
        ok(Array.isArray(request.options) && request.options.includes("选项甲"), "ask.options")
        state.askId = request.askId
        const answer = await t.post(`/api/asks/${encodeURIComponent(request.askId)}`, { answer: "选项甲" })
        assertStatus(answer, 200, "应答 ask")
        eq(answer.json?.ok, true, "应答 ask ok")
        eq(answer.json?.accepted, true, "应答 ask accepted")
        const terminal = await stream.collect({ timeoutMs: 90_000 })
        eq(terminal.type, "done", `ask 应答后终态 ${terminal.type}`)
        eq(terminal.reply, "收到回答，流程结束。", "ask 后续正文")
        const detail = await getConversation(t, conversation.id)
        const block = lastAssistant(detail.conversation).blocks.find((item) => item.type === "ask")
        ok(block !== undefined, "会话记录缺少 ask 块")
        eq(block.answer, "选项甲", "ask 块 answer")
    },
)

test(
    "F2",
    "ask 重复应答 stale",
    {
        severity: "P2",
        hint: "src/api/answers.ts 应答幂等",
        expectation: "同一 askId 再次应答 accepted=false / stale=true（或 410）",
    },
    async (t) => {
        ok(typeof state.askId === "string", "前置 F1 未拿到 askId")
        const response = await t.post(`/api/asks/${encodeURIComponent(state.askId)}`, { answer: "选项乙" })
        if (response.status === 410) {
            assertChineseError(response, "ask 重复应答")
            return
        }
        assertStatus(response, 200, "ask 重复应答")
        ok(
            response.json.accepted === false || response.json.stale === true,
            `重复应答未标记 stale：${JSON.stringify(response.json)}`,
        )
    },
)

test(
    "F3",
    "未知 askId",
    {
        severity: "P2",
        hint: "src/api/answers.ts",
        expectation: "未知 askId 返回 404/410 中文错误",
    },
    async (t) => {
        const response = await t.post("/api/asks/ask_does_not_exist", { answer: "x" })
        /* Lead 裁决：未知 askId 也返回 200，用 accepted=false/stale=true 表达幂等，不泄露是否存在 */
        assertStatus(response, 200, "未知 askId")
        eq(response.json?.ok, true, "未知 askId ok")
        eq(response.json?.accepted, false, "未知 askId accepted")
        eq(response.json?.stale, true, "未知 askId stale")
    },
)

/* ------------------------------------------------------------------ */
/* 用例：审批                                                          */
/* ------------------------------------------------------------------ */

async function runApprovalCase(t, approved) {
    const conversation = await createConversation(t, { permission: "read-only" })
    const stream = await t.chat(conversation.id, { message: "提权测试 [[stub:approval]]" })
    const approval = await stream.waitFor((event) => event.type === "approval" && event.request !== null, {
        timeoutMs: 30_000,
        label: "approval 事件",
    })
    const request = approval.request
    ok(typeof request.approvalId === "string" && request.approvalId !== "", "approval.approvalId 缺失")
    eq(request.currentPermission, "read-only", "approval.currentPermission")
    eq(request.requestedPermission, "workspace-write", "approval.requestedPermission")
    includes(request.command ?? "", "pwd", "approval.command")
    const answer = await t.post(`/api/approvals/${encodeURIComponent(request.approvalId)}`, { approved })
    assertStatus(answer, 200, "应答 approval")
    eq(answer.json?.accepted, true, "应答 approval accepted")
    const terminal = await stream.collect({ timeoutMs: 90_000 })
    eq(terminal.type, "done", `审批后终态 ${terminal.type}`)
    const detail = await getConversation(t, conversation.id)
    const block = lastAssistant(detail.conversation).blocks.find((item) => item.type === "approval")
    ok(block !== undefined, "会话记录缺少 approval 块")
    eq(block.approved, approved, "approval 块 approved")
    return { stream, detail, conversation }
}

test(
    "G1",
    "审批同意后继续",
    {
        severity: "P0",
        timeoutMs: 120_000,
        hint: "src/chat-runtime.ts approval 事件、src/api/answers.ts、宿主 respondApproval",
        expectation: "收到 approval；同意后工具执行成功并 done",
    },
    async (t) => {
        const result = await runApprovalCase(t, true)
        const end = result.stream.all("tool").find((event) => event.phase === "end")
        eq(end?.ok, true, "同意后工具 end.ok")
        state.approvalDone = true
    },
)

test(
    "G2",
    "审批拒绝后继续",
    {
        severity: "P1",
        timeoutMs: 120_000,
        hint: "src/chat-runtime.ts 审批拒绝路径",
        expectation: "拒绝后工具 end.ok=false、轮次仍 done",
    },
    async (t) => {
        const result = await runApprovalCase(t, false)
        const end = result.stream.all("tool").find((event) => event.phase === "end")
        eq(end?.ok, false, "拒绝后工具 end.ok")
    },
)

test(
    "G3",
    "未知 approvalId",
    {
        severity: "P2",
        hint: "src/api/answers.ts",
        expectation: "未知 approvalId 返回 404/410 中文错误",
    },
    async (t) => {
        const response = await t.post("/api/approvals/apv_does_not_exist", { approved: true })
        /* Lead 裁决：未知 approvalId 返回 200 + accepted=false/stale=true */
        assertStatus(response, 200, "未知 approvalId")
        eq(response.json?.ok, true, "未知 approvalId ok")
        eq(response.json?.accepted, false, "未知 approvalId accepted")
        eq(response.json?.stale, true, "未知 approvalId stale")
    },
)

/* ------------------------------------------------------------------ */
/* 用例：停止与插话                                                    */
/* ------------------------------------------------------------------ */

test(
    "H1",
    "停止：stopped 与宿主中止",
    {
        severity: "P0",
        timeoutMs: 60_000,
        hint: "src/api/chat.ts stop、src/chat-runtime.ts、宿主 api.agent.stop",
        expectation: "POST stop 返回 stopped=true；流收到 stopped 不发 done；宿主中止模型请求；会话状态 stopped 且保留正文",
    },
    async (t) => {
        await harness.resetStubStats()
        const conversation = await createConversation(t)
        const stream = await t.chat(conversation.id, { message: "慢速 [[stub:slow:250]]" })
        await stream.waitFor((event) => event.type === "delta", { timeoutMs: 20_000, label: "首个 delta" })
        const stop = await t.post(`/api/conversations/${conversation.id}/stop`)
        assertStatus(stop, 200, "停止")
        eq(stop.json?.ok, true, "stop.ok")
        eq(stop.json?.stopped, true, "stop.stopped")
        const terminal = await stream.collect({ timeoutMs: 30_000 })
        eq(terminal.type, "stopped", `停止后终态 ${terminal.type}`)
        eq(stream.all("done").length, 0, "停止后不应再发 done")
        const stats = await harness.stubStats()
        ok(stats.aborted >= 1, `宿主没有中止模型请求（stub.aborted=${stats.aborted}）`)
        const detail = await getConversation(t, conversation.id)
        const assistant = lastAssistant(detail.conversation)
        eq(assistant.status, "stopped", "停止后助手消息状态")
        ok(assistant.text.length > 0, "停止后已收正文被清空")
        state.stopConversationId = conversation.id
    },
)

test(
    "H2",
    "停止幂等",
    {
        severity: "P2",
        hint: "src/api/chat.ts stop 幂等",
        expectation: "再次 POST stop 返回 200 且 stopped=false",
    },
    async (t) => {
        const id = state.stopConversationId
        ok(typeof id === "string", "前置 H1 未完成")
        const response = await t.post(`/api/conversations/${id}/stop`)
        assertStatus(response, 200, "重复停止")
        ok(typeof response.json?.stopped === "boolean", "stop.stopped 不是布尔值")
    },
)

test(
    "H3",
    "插话 steer",
    {
        severity: "P0",
        timeoutMs: 60_000,
        hint: "src/api/chat.ts interject、src/chat-runtime.ts steer 事件、宿主 api.agent.interject",
        expectation: "流式中 POST interject 返回 accepted=true，流收到 steer 回显，宿主继续到 done",
    },
    async (t) => {
        const conversation = await createConversation(t)
        const stream = await t.chat(conversation.id, { message: "插话测试 [[stub:steer]]" })
        await stream.waitFor((event) => event.type === "tool" && event.phase === "start", {
            timeoutMs: 20_000,
            label: "慢工具 start",
        })
        const interject = await t.post(`/api/conversations/${conversation.id}/interject`, {
            message: "补充：插话测试",
        })
        assertStatus(interject, 200, "插话")
        eq(interject.json?.ok, true, "interject.ok")
        eq(interject.json?.accepted, true, "interject.accepted")
        const steer = await stream.waitFor((event) => event.type === "steer", {
            timeoutMs: 30_000,
            label: "steer 事件",
        })
        includes(steer.text ?? "", "插话测试", "steer.text")
        const terminal = await stream.collect({ timeoutMs: 60_000 })
        eq(terminal.type, "done", `插话后终态 ${terminal.type}`)
        eq(terminal.reply, SLOW_SCENARIO_TEXT_STEER, "插话后正文")
        const detail = await getConversation(t, conversation.id)
        const steerBlock = lastAssistant(detail.conversation).blocks.find((block) => block.type === "steer")
        ok(steerBlock !== undefined, "会话记录缺少 steer 块")
        const stats = await harness.stubStats()
        ok(
            (stats.requestsLog ?? []).some((request) => (request.userText ?? "").includes("插话测试")),
            "宿主没有把插话注入下一次模型请求",
        )
    },
)

test(
    "H4",
    "空闲会话插话返回 409",
    {
        severity: "P2",
        hint: "src/api/chat.ts interject 409",
        expectation: "轮次未运行时 POST interject 返回 409 中文错误",
    },
    async (t) => {
        const conversation = await createConversation(t)
        const response = await t.post(`/api/conversations/${conversation.id}/interject`, { message: "空闲插话" })
        eq(response.status, 409, "空闲插话状态码")
        assertChineseError(response, "空闲插话")
    },
)

/* ------------------------------------------------------------------ */
/* 用例：断线续接                                                      */
/* ------------------------------------------------------------------ */

test(
    "I1",
    "断线后 peek 与 resume 续接",
    {
        severity: "P0",
        timeoutMs: 120_000,
        hint: "src/api/chat.ts resume、src/chat-runtime.ts 事件缓冲",
        expectation: "断开后 peek 显示 active；resume?since=N 先发 resume 再重放剩余事件到 done；前后拼接正文完整且不重复",
    },
    async (t) => {
        await harness.resetStubStats()
        const conversation = await createConversation(t)
        const stream = await t.chat(conversation.id, { message: "续接测试 [[stub:slow:300]]" })
        await waitUntil(
            async () => stream.all("delta").length >= 3,
            { timeoutMs: 20_000, label: "收到至少 3 个增量" },
        )
        const since = stream.received
        stream.close()
        await sleep(300)
        const peek = await t.get(`/api/conversations/${conversation.id}/resume?since=${since}&peek=1`)
        assertStatus(peek, 200, "resume peek")
        eq(peek.json?.ok, true, "peek.ok")
        eq(peek.json?.active, true, "peek.active")
        ok(peek.json.total > since, `peek.total(${peek.json.total}) 应大于 since(${since})`)
        eq(peek.json.truncated, false, "peek.truncated")
        const resumed = await t.sse(`/api/conversations/${conversation.id}/resume?since=${since}`)
        includes(resumed.headers["content-type"] ?? "", "text/event-stream", "resume content-type")
        const resumeEvent = await resumed.waitType("resume", { timeoutMs: 20_000 })
        eq(resumeEvent.active, true, "resume.active")
        eq(resumeEvent.total, peek.json.total, "resume.total")
        ok(resumeEvent.from >= 0, "resume.from 缺失")
        const terminal = await resumed.collect({ timeoutMs: 90_000 })
        eq(terminal.type, "done", `续接终态 ${terminal.type}`)
        const combined = stream.deltaText() + resumed.deltaText()
        eq(combined, SLOW_TEXT, "断线前 + 续接后正文")
        ok(resumed.all("delta").length > 0, "续接没有重放剩余增量")
        const detail = await getConversation(t, conversation.id)
        eq(lastAssistant(detail.conversation).text, SLOW_TEXT, "续接完成后会话正文")
        eq(lastAssistant(detail.conversation).status, "done", "续接完成后消息状态")
        state.resumeConversationId = conversation.id
    },
)

test(
    "I2",
    "完成后 peek 与无活跃轮次 resume",
    {
        severity: "P1",
        hint: "src/api/chat.ts resume 语义",
        expectation: "peek=1 返回 active=false/done=true；非 peek 请求不再挂起",
    },
    async (t) => {
        const id = state.resumeConversationId
        ok(typeof id === "string", "前置 I1 未完成")
        const peek = await t.get(`/api/conversations/${id}/resume?since=0&peek=1`)
        assertStatus(peek, 200, "完成后 peek")
        eq(peek.json?.ok, true, "完成后 peek.ok")
        eq(peek.json?.active, false, "完成后 peek.active")
        eq(peek.json?.done, true, "完成后 peek.done")
        const plain = await request(harness.webBase, `/api/conversations/${id}/resume?since=0`, {
            timeoutMs: 10_000,
        })
        eq(plain.status, 200, "无活跃轮次 resume 状态码")
        const contentType = plain.headers["content-type"] ?? ""
        if (contentType.includes("application/json")) {
            eq(plain.json?.ok, false, "无活跃轮次 resume.ok")
            assertChineseError(plain, "无活跃轮次 resume")
        } else {
            /* 允许实现选择重放已结束轮次：至少不能挂起或 500 */
            includes(contentType, "text/event-stream", "无活跃轮次 resume content-type")
        }
    },
)

test(
    "I3",
    "从未运行的会话 peek",
    {
        severity: "P2",
        hint: "src/api/chat.ts resume peek",
        expectation: "peek=1 返回 200 JSON，active=false、total=0",
    },
    async (t) => {
        const conversation = await createConversation(t)
        const peek = await t.get(`/api/conversations/${conversation.id}/resume?peek=1`)
        assertStatus(peek, 200, "空会话 peek")
        isType(peek.json, "object", "空会话 peek")
        eq(peek.json.active, false, "空会话 peek.active")
        if (peek.json.ok === true) {
            /* 文档约定的 peek 形状 */
            ok("total" in peek.json && peek.json.total === 0, `空会话 peek.total 应为 0：${peek.text.slice(0, 200)}`)
            eq(peek.json.done, true, "空会话 peek.done")
            return
        }
        /* 实现选择「没有可续接的回复」时给中文说明 */
        assertChineseError(peek, "空会话 peek")
    },
)

/* ------------------------------------------------------------------ */
/* 用例：持久化与宿主重启                                              */
/* ------------------------------------------------------------------ */

test(
    "J1",
    "会话数据落盘",
    {
        severity: "P1",
        hint: "src/chat-store.ts chat/index.json 与 conversations/<id>.json",
        expectation: "插件数据目录 chat/ 下存在索引和会话文件，字段符合 v:1 契约",
    },
    async (t) => {
        const id = state.normalConversationId
        ok(typeof id === "string", "前置 D1 未完成")
        const chatDir = path.join(harness.pluginDataDir(), "chat")
        const indexFile = path.join(chatDir, "index.json")
        const conversationFile = path.join(chatDir, "conversations", `${id}.json`)
        ok(fs.existsSync(indexFile), `缺少 ${indexFile}`)
        ok(fs.existsSync(conversationFile), `缺少 ${conversationFile}`)
        const index = JSON.parse(fs.readFileSync(indexFile, "utf8"))
        eq(index.v, 1, "index.v")
        ok(Array.isArray(index.conversations), "index.conversations 不是数组")
        ok(index.conversations.some((item) => item.id === id), "index 不含会话")
        const stored = JSON.parse(fs.readFileSync(conversationFile, "utf8"))
        eq(stored.v, 1, "conversation.v")
        eq(stored.id, id, "conversation.id")
        ok(stored.messages.length >= 2, "落盘消息数不足")
        ok(stored.messages.every((message) => typeof message.status === "string"), "落盘消息缺 status")
    },
)

test(
    "J2",
    "宿主重启后继续会话",
    {
        severity: "P0",
        timeoutMs: 180_000,
        hint: "src/chat-runtime.ts 宿主重启语义、sessionId+cwd 复用、src/chat-store.ts",
        expectation: "重启后 GET 会话仍在；带原 sessionId/cwd 继续得到 done.turn=2 且 sessionId 不变",
    },
    async (t) => {
        const conversation = await createConversation(t, { title: "重启后续接" })
        const first = await chatToTerminal(t, conversation.id, "第一轮 [[stub:text]]")
        eq(first.terminal.type, "done", "重启前第一轮终态")
        const sessionId = first.terminal.sessionId
        ok(typeof sessionId === "string" && sessionId !== "", "第一轮没有 sessionId")
        await harness.restartHost()
        const detail = await getConversation(t, conversation.id)
        eq(detail.conversation.messages.length, 2, "重启后历史消息数")
        const second = await t.chat(conversation.id, { message: "第二轮 [[stub:text]]" })
        const sessionEvent = await second.waitType("session", { timeoutMs: 30_000 })
        eq(sessionEvent.sessionId, sessionId, "重启后 sessionId")
        const terminal = await second.collect({ timeoutMs: 90_000 })
        eq(terminal.type, "done", `重启后第二轮终态 ${terminal.type}`)
        eq(terminal.turn, 2, "重启后 done.turn")
        const after = await getConversation(t, conversation.id)
        eq(after.conversation.messages.length, 4, "重启后两轮消息数")
        eq(after.conversation.sessionId, sessionId, "重启后会话记录 sessionId")
        state.restartConversationId = conversation.id
        state.restartDone = true
    },
)

test(
    "J3",
    "重启后会话列表保留",
    {
        severity: "P1",
        hint: "src/chat-store.ts 索引持久化",
        expectation: "宿主重启后 /api/conversations 仍包含历史会话",
    },
    async (t) => {
        ok(state.restartDone === true, "前置 J2 未完成")
        const list = await t.get("/api/conversations")
        assertStatus(list, 200, "重启后会话列表")
        ok(
            list.json.conversations.some((item) => item.id === state.restartConversationId),
            "重启后列表丢失会话",
        )
    },
)

/* ------------------------------------------------------------------ */
/* 用例：模型、工作区、文件                                            */
/* ------------------------------------------------------------------ */

test(
    "L1",
    "模型列表",
    {
        severity: "P1",
        hint: "src/api/state.ts models、宿主 models API",
        expectation: "GET /api/models 返回 providers 与 activeProvider/activeModel",
    },
    async (t) => {
        const response = await t.get("/api/models")
        assertStatus(response, 200, "模型列表")
        const models = response.json?.models
        ok(models !== null && typeof models === "object", "models 为 null")
        ok(Array.isArray(models.providers), "models.providers 不是数组")
        ok(models.providers.some((provider) => provider.id === "stub"), "缺少 stub 供应商")
        eq(models.activeProvider, "stub", "activeProvider")
        eq(models.activeModel, "stub-1", "activeModel")
    },
)

test(
    "L2",
    "设置全局模型",
    {
        severity: "P2",
        hint: "src/api/state.ts POST /api/models/active",
        expectation: "POST 后返回更新后的 models",
    },
    async (t) => {
        const response = await t.post("/api/models/active", { providerId: "stub", model: "stub-1", reasoning: "off" })
        assertStatus(response, 200, "设置 active 模型")
        eq(response.json?.models?.activeProvider, "stub", "activeProvider")
        eq(response.json?.models?.activeModel, "stub-1", "activeModel")
    },
)

test(
    "L3",
    "工作区增删与校验",
    {
        severity: "P1",
        hint: "src/api/files.ts workspaces、宿主 workspaces API",
        expectation: "注册返回 workspace；validate 可用目录 ok=true、不存在目录 ok=false；删除后列表移除",
    },
    async (t) => {
        const add = await t.post("/api/workspaces", { root: t.workDir, name: "E2E 工作区" })
        assertStatus(add, 200, "注册工作区")
        const workspace = add.json?.workspace
        ok(workspace !== undefined && typeof workspace.id === "string", "注册工作区缺少 workspace.id")
        includes(workspace.root ?? "", "work", "workspace.root")
        const valid = await t.post("/api/workspaces/validate", { root: t.workDir })
        assertStatus(valid, 200, "校验工作区")
        eq(valid.json?.ok, true, "校验可用目录")
        const invalid = await t.post("/api/workspaces/validate", { root: "/definitely-not-exist-e2e" })
        assertStatus(invalid, 200, "校验坏目录")
        eq(invalid.json?.ok, false, "校验坏目录 ok")
        const remove = await t.del(`/api/workspaces/${encodeURIComponent(workspace.id)}`)
        assertStatus(remove, 200, "删除工作区")
        const list = await t.get("/api/workspaces")
        ok(
            !(list.json?.workspaces ?? []).some((item) => item.id === workspace.id),
            "删除后工作区仍在列表",
        )
    },
)

test(
    "L4",
    "工作区文件搜索",
    {
        severity: "P1",
        hint: "src/api/files.ts GET /api/files",
        expectation: "在隔离工作区搜索 hello 能找到 hello.txt",
    },
    async (t) => {
        const response = await t.get(`/api/files?root=${encodeURIComponent(t.workDir)}&q=hello`)
        assertStatus(response, 200, "文件搜索")
        includes(JSON.stringify(response.json ?? {}), "hello", "文件搜索结果")
    },
)

test(
    "L5",
    "打开文件参数校验",
    {
        severity: "P2",
        hint: "src/api/files.ts POST /api/files/open",
        expectation: "相对路径被拒绝（4xx 中文错误）",
    },
    async (t) => {
        const relative = await t.post("/api/files/open", { path: "relative/path.txt" })
        eq(relative.status, 400, "相对路径打开状态码")
        assertChineseError(relative, "打开文件参数")
        /* 宿主 api.agent.openPath 只返回 void，不校验存在性；插件无法判断，保留 ok:true */
        const missing = await t.post("/api/files/open", { path: path.join(t.workDir, "不存在-e2e.txt") })
        assertStatus(missing, 200, "打开不存在路径")
        eq(missing.json?.ok, true, "打开不存在路径 ok")
    },
)

/* ------------------------------------------------------------------ */
/* 用例：模型错误与缺 Key                                              */
/* ------------------------------------------------------------------ */

test(
    "K1",
    "模型 500 错误",
    {
        severity: "P1",
        timeoutMs: 90_000,
        hint: "src/chat-runtime.ts 宿主错误映射中文",
        expectation: "流收到 error（中文），会话消息状态 error，且不发 done",
    },
    async (t) => {
        const conversation = await createConversation(t)
        const stream = await t.chat(conversation.id, { message: "故意报错 [[stub:500]]" })
        const terminal = await stream.collect({ timeoutMs: 90_000 })
        eq(terminal.type, "error", `500 场景终态 ${terminal.type}`)
        ok(
            typeof terminal.error === "string" && /[\u4e00-\u9fff]/.test(terminal.error),
            `错误信息不是中文：${terminal.error}`,
        )
        eq(stream.all("done").length, 0, "错误场景不应发 done")
        const detail = await getConversation(t, conversation.id)
        eq(lastAssistant(detail.conversation)?.status, "error", "错误场景消息状态")
    },
)

test(
    "K2",
    "模型空回复错误",
    {
        severity: "P1",
        timeoutMs: 90_000,
        hint: "src/chat-runtime.ts 错误映射",
        expectation: "空回复映射为中文 error 事件",
    },
    async (t) => {
        const conversation = await createConversation(t)
        const stream = await t.chat(conversation.id, { message: "空回复 [[stub:empty]]" })
        const terminal = await stream.collect({ timeoutMs: 90_000 })
        eq(terminal.type, "error", `空回复终态 ${terminal.type}`)
        ok(
            typeof terminal.error === "string" && /[\u4e00-\u9fff]/.test(terminal.error),
            `空回复错误信息不是中文：${terminal.error}`,
        )
    },
)

test(
    "K3",
    "模型连接中断错误",
    {
        severity: "P2",
        timeoutMs: 90_000,
        hint: "src/chat-runtime.ts 网络错误映射",
        expectation: "模型连接中途断开映射为中文 error，不崩溃",
    },
    async (t) => {
        const conversation = await createConversation(t)
        const stream = await t.chat(conversation.id, { message: "中途断开 [[stub:error-mid]]" })
        const terminal = await stream.collect({ timeoutMs: 90_000 })
        eq(terminal.type, "error", `连接中断终态 ${terminal.type}`)
        ok(
            typeof terminal.error === "string" && /[\u4e00-\u9fff]/.test(terminal.error),
            `连接中断错误信息不是中文：${terminal.error}`,
        )
    },
)

test(
    "K4",
    "缺少 API Key 的中文错误",
    {
        severity: "P1",
        timeoutMs: 180_000,
        hint: "src/chat-runtime.ts 缺 Key 映射、宿主 agent-service 错误",
        expectation: "删除 credentials 中的 key 并重启后，chat 流返回中文 error（提示配置密钥）",
    },
    async (t) => {
        const credentialsFile = path.join(harness.home, "config", "credentials.json")
        const backup = `${credentialsFile}.e2e-bak`
        await fsp.copyFile(credentialsFile, backup)
        try {
            await fsp.writeFile(
                credentialsFile,
                `${JSON.stringify({ version: 2, openai: { apiKey: "" }, providers: {} }, null, 4)}\n`,
            )
            await harness.restartHost()
            const conversation = await createConversation(t)
            const stream = await t.chat(conversation.id, { message: "无密钥测试 [[stub:text]]" })
            const terminal = await stream.collect({ timeoutMs: 90_000 })
            eq(terminal.type, "error", `缺 Key 终态 ${terminal.type}`)
            const message = String(terminal.error ?? "")
            ok(/[\u4e00-\u9fff]/.test(message), `缺 Key 错误信息不是中文：${message}`)
            ok(
                /密钥|key|API|模型/.test(message),
                `缺 Key 错误信息未说明原因：${message}`,
            )
        } finally {
            await fsp.copyFile(backup, credentialsFile)
            await fsp.rm(backup, { force: true })
            await harness.restartHost()
        }
    },
)

/* ------------------------------------------------------------------ */
/* 用例：浏览器                                                        */
/* ------------------------------------------------------------------ */

test(
    "BR1",
    "浏览器真实交互、主题与截图",
    {
        severity: "P0",
        requiresApi: false,
        timeoutMs: 240_000,
        hint: "www/ 构建产物、frontend/src/store.ts、frontend/src/App.vue",
        expectation: "页面无白屏、控制台无 JS/CSP 报错、桌面/窄屏/暗色截图；后端就绪时在 UI 里完成一轮对话",
    },
    async (t) => {
        const browser = await runBrowserChecks({
            harness,
            shotsDir: options.shots,
            runId,
            interaction: harness.backendReady,
            replyText: DEFAULT_MODEL_TEXT,
        })
        state.browser = browser
        const required = harness.backendReady
            ? [
                  "页面可渲染（无白屏）",
                  "bootstrap 完成（侧栏/输入区出现）",
                  "新建会话并完成普通对话",
                  "工具行折叠与展开",
                  "ask 在 UI 中回答并继续",
                  "approval 批准后继续",
                  "approval 拒绝后继续",
                  "流式中停止",
                  "错误后点重试",
                  "长文本自动跟随底部",
                  "ask 跳过",
                  "刷新断开后自动续接",
                  "SSE chat 响应均为 200",
                  "控制台无 JS/CSP 报错",
                  "静态资源无 4xx/5xx",
                  "截图完整",
                  "暗色主题生效",
                  "窄屏无横向溢出",
                  "窄屏输入区可用",
                  "直连端口可渲染",
              ]
            : ["页面可渲染（无白屏）"]
        const failedChecks = browser.checks.filter((check) => required.includes(check.name) && !check.pass)
        const screenshotsMissing = browser.screenshots.filter((shot) => !fs.existsSync(shot.file) || fs.statSync(shot.file).size < 1_000)
        if (failedChecks.length > 0) {
            throw new Error(failedChecks.map((check) => `${check.name}：${check.detail}`).join("；"))
        }
        if (screenshotsMissing.length > 0) {
            throw new Error(`截图缺失或过小：${screenshotsMissing.map((shot) => shot.file).join("，")}`)
        }
        if (harness.backendReady) {
            ok(browser.interaction?.ran === true, "浏览器真实交互场景未执行")
        }
    },
)

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const options = parseArgs(process.argv.slice(2))

async function buildUiIfRequested() {
    if (!options.buildUi) {
        return
    }
    console.log("[准备] pnpm run build:ui …")
    const result = spawnSync("pnpm", ["run", "build:ui"], { cwd: REPO_ROOT, encoding: "utf8", timeout: 180_000 })
    if (result.status !== 0) {
        console.error("[准备] 前端构建失败（继续用现有 www/）：")
        console.error((result.stdout ?? "").slice(-1_500))
        console.error((result.stderr ?? "").slice(-1_500))
    } else {
        console.log("[准备] 前端构建完成")
    }
}

async function main() {
    await fsp.mkdir(options.shots, { recursive: true })
    await buildUiIfRequested()

    harness = createHarness({})
    let prepared = false
    const results = []
    let finalError = null
    try {
        console.log("[准备] 启动隔离宿主与 stub 模型 …")
        await harness.prepare()
        prepared = true
        console.log(`[准备] home=${harness.home}`)
        console.log(`[准备] 直连=${harness.webBase}/ 网关=${harness.gatewayBase}/web/`)
        console.log(`[准备] 后端就绪=${harness.backendReady ? "是" : "否"}，网关路由=${harness.gatewayReady ? "就绪" : "不可用"}`)
        if (harness.health !== null && harness.health.sso !== "disabled") {
            console.log(`[准备] 注意：sso=${harness.health.sso}，直连可能需要登录`)
        }

        const filtered = cases.filter((item) => {
            if (options.only === null) {
                return true
            }
            return options.only.some((pattern) => item.id.startsWith(pattern) || item.name.includes(pattern))
        })
        if (filtered.length === 0) {
            throw new Error("没有匹配的用例")
        }

        let index = 0
        for (const item of filtered) {
            index += 1
            const label = `[${String(index).padStart(2, "0")}/${filtered.length}] ${item.id} ${item.name}`
            let skipReason = typeof item.skip === "function" ? item.skip() : (item.skip ?? null)
            if (skipReason === null && !harness.backendReady && item.requiresApi) {
                skipReason = "后端 API 未就绪（/api/bootstrap 不可用），等待 backend 实现"
            }
            if (skipReason !== null) {
                results.push({ ...item, status: "skip", ms: 0, skipReason })
                console.log(`  - 跳过 ${label}：${skipReason}`)
                continue
            }
            const context = createContext()
            const startedAt = Date.now()
            try {
                await withTimeout(() => item.fn(context, state), item.timeoutMs, item.name)
                const ms = Date.now() - startedAt
                results.push({ ...item, status: "pass", ms })
                console.log(`  ✓ ${label}（${ms}ms）`)
            } catch (error) {
                const ms = Date.now() - startedAt
                const message = error instanceof Error ? error.message : String(error)
                results.push({
                    ...item,
                    status: "fail",
                    ms,
                    error: message,
                    logTail: harness.tailHostLog(14),
                })
                console.log(`  ✗ ${label}（${ms}ms）：${message.split("\n")[0]}`)
            } finally {
                context.closeStreams()
            }
        }
    } catch (error) {
        finalError = error
        console.error(`[致命] ${error instanceof Error ? error.message : String(error)}`)
    } finally {
        if (harness !== null) {
            /* 报告与日志在清理前落盘 */
            const summary = summarize(results)
            const extra = {
                backendReady: harness.backendReady,
                screenshots: state.browser?.screenshots ?? [],
                browser: buildBrowserNotes(state.browser, harness.backendReady),
                stubStats: await harness.stubStats().catch(() => undefined),
                entries: buildEntryStats(results),
                hostErrorLines: buildHostErrorLines(harness),
                advisories: buildAdvisories(harness, state.browser),
                notes: buildNotes(summary, harness),
            }
            const report = buildReport({ harness, results, extra })
            try {
                await fsp.mkdir(path.dirname(options.report), { recursive: true })
                await fsp.writeFile(options.report, report)
            } catch (error) {
                console.error(`写报告失败：${error instanceof Error ? error.message : String(error)}`)
            }
            /* 日志另存到 /tmp/e2e-logs，删除 home 后仍可排查 */
            try {
                const logsDir = "/tmp/e2e-logs"
                await fsp.mkdir(logsDir, { recursive: true })
                await fsp.copyFile(harness.logs.hostFile, path.join(logsDir, `${runId}-host.log`)).catch(() => {})
                await fsp.copyFile(harness.logs.stubFile, path.join(logsDir, `${runId}-stub.log`)).catch(() => {})
            } catch {
                /* 日志复制失败不影响结果 */
            }
            if (prepared) {
                const failed = results.some((item) => item.status === "fail") || finalError !== null
                const cleanup = await harness.cleanup({ success: !failed, keep: options.keep || failed })
                console.log(
                    cleanup.removed
                        ? "[清理] 已删除临时 home"
                        : `[清理] 保留现场：${cleanup.home}`,
                )
            } else {
                await harness.cleanup({ success: false, keep: true }).catch(() => {})
            }

            console.log("")
            console.log(`结果：通过 ${summary.passed}，失败 ${summary.failed}，跳过 ${summary.skipped}，共 ${summary.total}；用时 ${((Date.now() - harness.startedAt) / 1000).toFixed(1)}s`)
            if (summary.failed > 0) {
                for (const level of ["p0", "p1", "p2"]) {
                    if (summary[level].length > 0) {
                        console.log(`  ${level.toUpperCase()}：${summary[level].join("；")}`)
                    }
                }
            }
            console.log(`报告：${options.report}`)
            if (state.browser?.screenshots?.length > 0) {
                console.log(`截图：${path.dirname(state.browser.screenshots[0].file)}`)
            }
            console.log("")
        }
    }

    if (finalError !== null) {
        console.error(`致命错误：${finalError instanceof Error ? finalError.stack ?? finalError.message : String(finalError)}`)
        process.exit(2)
    }
    const failed = results.some((item) => item.status === "fail")
    process.exit(failed ? 1 : 0)
}

const ENTRY_NAMES = { direct: "直连入口", gateway: "网关入口" }

/** 按入口统计通过/失败，报告里分两组展示 */
function buildEntryStats(results) {
    return Object.entries(ENTRY_NAMES).map(([key, name]) => {
        const group = results.filter((item) => item.entry === key)
        return {
            name,
            passed: group.filter((item) => item.status === "pass").length,
            failed: group.filter((item) => item.status === "fail").length,
            skipped: group.filter((item) => item.status === "skip").length,
            cases: group.map((item) => item.id),
        }
    })
}

/** 宿主日志里的告警/错误行，报告失败时用于定位 */
function buildHostErrorLines(harnessInstance) {
    const matched = harnessInstance.logs.host.filter((line) => /\[ERROR\]|\[WARN \]|失败|错误/.test(line))
    const lines = matched.slice(-20)
    return lines.length > 0 ? lines : harnessInstance.logs.host.slice(-10)
}

const OBSERVATIONS = [
    "CSRF 头为 x-web-request: 1（不是 x-wellspring-*，网关会过滤该前缀）。",
    "截图与会话标题里的 [[stub:*]] 是 e2e 测试标记，用于驱动 stub 模型，生产环境不会出现。",
]

/** 未判失败但值得记录的观察项 */
function buildAdvisories(harnessInstance, browser) {
    const advisories = [
        {
            severity: "P2",
            title: "files/open 不校验路径存在性",
            detail: "宿主 api.agent.openPath 只返回 void，插件无法判断路径是否存在，按契约返回 ok:true（Lead 已裁决保留）",
            hint: "前端点击文件前可先用 /api/files 确认路径；或在插件层用 workspaceFs.stat 预检",
        },
    ]
    for (const item of browser?.advisories ?? []) {
        advisories.push(item)
    }
    return advisories
}

function buildNotes(summary, harnessInstance) {
    const notes = []
    if (!harnessInstance.backendReady) {
        notes.push("后端 API 未就绪：/api/bootstrap 不可用，本轮只验证了静态/健康检查与基础浏览器渲染。")
    }
    if (summary.p0.length > 0) {
        notes.push(`存在 P0 缺陷：${summary.p0.join("；")}`)
    }
    notes.push("")
    notes.push("观察与建议：")
    for (const item of OBSERVATIONS) {
        notes.push(`- ${item}`)
    }
    return notes.join("\n")
}

function buildBrowserNotes(browser, backendReady) {
    if (browser === undefined) {
        return []
    }
    const notes = []
    for (const check of browser.checks) {
        notes.push(`${check.pass ? "✓" : "✗"} ${check.name}${check.detail === "" ? "" : `：${check.detail}`}`)
    }
    notes.push(`入口：${browser.base}；Chrome：${browser.chrome}`)
    if (!backendReady) {
        notes.push("后端未就绪，浏览器检查只做基础渲染（暗色/窄屏/控制台检查仅供参考）")
    }
    return notes
}

main().catch((error) => {
    console.error(error)
    process.exit(2)
})
