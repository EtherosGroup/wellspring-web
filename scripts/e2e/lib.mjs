/*
 * e2e 公共库：HTTP 调用、SSE 解析、断言与报告
 *
 * 只用 Node 原生模块；SSE 客户端按浏览器语义记录已收到的数据事件数（不含注释 ping）。
 */

import path from "node:path"

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

export const WRITE_HEADER = { "x-web-request": "1" }

/**
 * 发一个 JSON 请求并解析响应
 *
 * @param {string} baseUrl 例如 http://127.0.0.1:9787
 * @param {string} pathname /api/bootstrap
 */
export async function request(baseUrl, pathname, options = {}) {
    const { method = "GET", body, headers = {}, timeoutMs = 15_000, raw = false, writeHeader = true } = options
    const finalHeaders = { ...headers }
    if (body !== undefined && !raw) {
        finalHeaders["content-type"] = "application/json"
    }
    if (method !== "GET" && method !== "HEAD" && writeHeader) {
        Object.assign(finalHeaders, WRITE_HEADER, finalHeaders)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const response = await fetch(`${baseUrl}${pathname}`, {
            method,
            headers: finalHeaders,
            body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
            signal: controller.signal,
        })
        const text = await response.text()
        let json = null
        try {
            json = JSON.parse(text)
        } catch {
            /* 非 JSON 响应保留 text */
        }
        return {
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            text,
            json,
        }
    } finally {
        clearTimeout(timer)
    }
}

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */

export const TERMINAL_TYPES = new Set(["done", "error", "stopped", "truncated", "replaced"])

/**
 * 打开一个 SSE 流并增量解析
 *
 * 用法：`const stream = await openSse(url, {method:"POST", body})`
 * - `stream.events` 已收到的数据事件
 * - `stream.received` 已收到的数据事件数（续接用的 since）
 * - `stream.waitFor(predicate, {timeoutMs})` 等到满足条件的事件
 * - `stream.collect()` 读到终态事件或流结束
 * - `stream.close()` 主动断开（模拟刷新/切后台）
 */
export async function openSse(url, options = {}) {
    const { method = "GET", body, headers = {}, timeoutMs = 30_000 } = options
    const finalHeaders = { accept: "text/event-stream", ...headers }
    if (body !== undefined) {
        finalHeaders["content-type"] = "application/json"
    }
    if (method !== "GET") {
        Object.assign(finalHeaders, WRITE_HEADER, finalHeaders)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
        response = await fetch(url, {
            method,
            headers: finalHeaders,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
        })
    } finally {
        clearTimeout(timer)
    }
    if (!response.ok) {
        const text = await response.text().catch(() => "")
        throw new Error(`SSE 请求失败 ${response.status}：${text.slice(0, 400)}`)
    }
    const stream = new SseStream(response, controller)
    stream.start()
    return stream
}

class SseStream {
    constructor(response, controller) {
        this.response = response
        this.controller = controller
        this.events = []
        this.pings = 0
        this.invalidFrames = 0
        this.ended = false
        this.closedByClient = false
        this.error = null
        this._waiters = new Set()
        this._donePromise = new Promise((resolve) => {
            this._resolveDone = resolve
        })
    }

    get received() {
        return this.events.length
    }

    get status() {
        return this.response.status
    }

    get headers() {
        return Object.fromEntries(this.response.headers.entries())
    }

    start() {
        this._read().catch((error) => {
            if (this.closedByClient || error?.name === "AbortError") {
                return
            }
            this.error = error
            this.ended = true
            this._resolveDone()
        })
    }

    async _read() {
        const reader = this.response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        const handleFrame = (frame) => {
            const dataLines = []
            for (const line of frame.split("\n")) {
                if (line.startsWith(":")) {
                    this.pings += 1
                    continue
                }
                if (line.startsWith("data:")) {
                    dataLines.push(line.slice(5).replace(/^ /, ""))
                }
            }
            if (dataLines.length === 0) {
                return
            }
            const payload = dataLines.join("\n")
            let event
            try {
                event = JSON.parse(payload)
            } catch {
                this.invalidFrames += 1
                return
            }
            this.events.push(event)
            for (const waiter of [...this._waiters]) {
                waiter()
            }
        }
        for (;;) {
            const { value, done } = await reader.read()
            if (done) {
                if (buffer.trim() !== "") {
                    handleFrame(buffer)
                }
                break
            }
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
            let index = buffer.indexOf("\n\n")
            while (index >= 0) {
                const frame = buffer.slice(0, index)
                buffer = buffer.slice(index + 2)
                handleFrame(frame)
                index = buffer.indexOf("\n\n")
            }
        }
        this.ended = true
        this._resolveDone()
    }

    /** 等到满足条件的事件；返回事件本身 */
    async waitFor(predicate, { timeoutMs = 30_000, label = "SSE 事件" } = {}) {
        const check = () => this.events.find((event) => predicate(event))
        const deadline = Date.now() + timeoutMs
        for (;;) {
            const hit = check()
            if (hit !== undefined) {
                return hit
            }
            if (this.ended) {
                throw new Error(`${label}未出现：流速已结束（已收 ${this.events.length} 个事件${this.error === null ? "" : `，错误：${this.error.message}`}）`)
            }
            if (Date.now() >= deadline) {
                throw new Error(`${label}超时（${timeoutMs}ms，已收 ${this.events.length} 个事件）`)
            }
            await Promise.race([
                new Promise((resolve) => {
                    const waiter = () => {
                        this._waiters.delete(waiter)
                        resolve()
                    }
                    this._waiters.add(waiter)
                }),
                sleep(Math.min(50, Math.max(5, deadline - Date.now()))),
            ])
        }
    }

    waitType(type, options = {}) {
        return this.waitFor((event) => event.type === type, { label: `事件 ${type}`, ...options })
    }

    /** 读取到终态事件（done/error/stopped/...）或流结束 */
    async collect({ timeoutMs = 120_000, label = "等待终态事件" } = {}) {
        const deadline = Date.now() + timeoutMs
        for (;;) {
            const terminal = this.events.find((event) => TERMINAL_TYPES.has(event.type))
            if (terminal !== undefined) {
                return terminal
            }
            if (this.ended) {
                throw new Error(
                    `${label}失败：流速结束但没有终态事件（已收 ${this.events.length} 个事件${this.error === null ? "" : `，错误：${this.error.message}`}）`,
                )
            }
            if (Date.now() >= deadline) {
                throw new Error(`${label}超时（${timeoutMs}ms，已收 ${this.events.length} 个事件）`)
            }
            await sleep(10)
        }
    }

    /** 取某个类型的全部事件 */
    all(type) {
        return this.events.filter((event) => event.type === type)
    }

    /** 拼接正文增量 */
    deltaText() {
        return this.all("delta")
            .map((event) => event.text ?? "")
            .join("")
    }

    /** 主动断开；浏览器刷新/切后台就是这个语义 */
    close() {
        this.closedByClient = true
        try {
            this.controller.abort()
        } catch {
            /* 已结束 */
        }
    }
}

/* ------------------------------------------------------------------ */
/* 断言与错误                                                          */
/* ------------------------------------------------------------------ */

export function ok(condition, message) {
    if (!condition) {
        throw new Error(message)
    }
}

export function eq(actual, expected, label) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${label}不符：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
    }
}

export function includes(haystack, needle, label) {
    const text = typeof haystack === "string" ? haystack : JSON.stringify(haystack)
    if (!text.includes(needle)) {
        throw new Error(`${label}不含 ${JSON.stringify(needle)}：${text.slice(0, 400)}`)
    }
}

export function isType(value, type, label) {
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value
    if (actual !== type) {
        throw new Error(`${label}类型不符：期望 ${type}，实际 ${actual}`)
    }
}

/** 带中文说明的断言失败信息 */
export function assertStatus(response, expected, label) {
    if (response.status !== expected) {
        throw new Error(`${label}状态码 ${response.status}（期望 ${expected}）：${response.text.slice(0, 400)}`)
    }
}

/** 错误响应应带中文 error 字段 */
export function assertChineseError(response, label) {
    const json = response.json
    ok(json !== null && typeof json.error === "string" && json.error !== "", `${label}响应没有 error 字段：${response.text.slice(0, 300)}`)
    ok(/[\u4e00-\u9fff]/.test(json.error), `${label}错误信息不是中文：${json.error}`)
    return json.error
}

export function assertJsonError(response, label) {
    ok(
        response.headers["content-type"]?.includes("application/json"),
        `${label}响应不是 JSON：${response.headers["content-type"]} ${response.text.slice(0, 200)}`,
    )
    assertChineseError(response, label)
}

/* ------------------------------------------------------------------ */
/* 报告                                                                */
/* ------------------------------------------------------------------ */

const SEVERITY_LABEL = { P0: "P0 阻断", P1: "P1 严重", P2: "P2 一般" }

/**
 * 生成 /tmp/e2e-report.md 的 Markdown
 *
 * @param {object} input
 * @param {object} input.harness
 * @param {Array} input.results  {id,name,severity,status,ms,error,hint,skipReason}
 * @param {object} [input.extra] {backendReady, screenshots, stubStats, rounds, notes}
 */
export function buildReport({ harness, results, extra = {} }) {
    const passed = results.filter((item) => item.status === "pass")
    const failed = results.filter((item) => item.status === "fail")
    const skipped = results.filter((item) => item.status === "skip")
    const failedP0 = failed.filter((item) => item.severity === "P0")
    const lines = []
    lines.push("# wellspring-web 0.4.0 端到端验证报告")
    lines.push("")
    lines.push(`生成时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`)
    lines.push("")
    lines.push("## 环境")
    lines.push("")
    lines.push(`- 隔离 home：\`${harness.home}\``)
    lines.push(`- 直连地址：${harness.webBase}（网关 ${harness.gatewayBase}）`)
    lines.push(`- 工作区：\`${harness.workDir}\``)
    lines.push(`- 插件/网关健康：${harness.health === null ? "未知" : JSON.stringify(harness.health)}`)
    lines.push(`- 网关 /web 路由：${harness.gatewayReady ? "就绪" : "不可用"}`)
    lines.push(`- 后端 API：${harness.backendReady ? "就绪" : "未就绪（/api/bootstrap 不可用）"}`)
    lines.push(`- 宿主日志：\`${harness.logs.hostFile}\``)
    lines.push("")
    lines.push("## 结果")
    lines.push("")
    lines.push(`通过 ${passed.length}，失败 ${failed.length}，跳过 ${skipped.length}，共 ${results.length}`)
    if (failed.length > 0) {
        const counts = ["P0", "P1", "P2"].map((level) => {
            const count = failed.filter((item) => item.severity === level).length
            return count > 0 ? `${SEVERITY_LABEL[level]} ${count}` : null
        }).filter(Boolean)
        lines.push(`失败分布：${counts.join("，")}`)
    }
    lines.push("")
    lines.push("| 状态 | 用例 | 级别 | 耗时 | 说明 |")
    lines.push("| --- | --- | --- | --- | --- |")
    for (const item of results) {
        const status = item.status === "pass" ? "✅ 通过" : item.status === "skip" ? "⏭️ 跳过" : "❌ 失败"
        const note = item.status === "fail" ? String(item.error ?? "").split("\n")[0] : (item.skipReason ?? "")
        lines.push(`| ${status} | ${item.id} ${item.name} | ${item.severity} | ${item.ms ?? 0}ms | ${escapeCell(note)} |`)
    }
    if (extra.entries !== undefined) {
        lines.push("")
        lines.push("## 入口覆盖")
        lines.push("")
        for (const entry of extra.entries) {
            lines.push(`- ${entry.name}：通过 ${entry.passed}，失败 ${entry.failed}，跳过 ${entry.skipped}（${entry.cases.join("、") || "无"}）`)
        }
    }
    lines.push("")
    if (failed.length > 0) {
        lines.push("## 缺陷")
        lines.push("")
        for (const level of ["P0", "P1", "P2"]) {
            const group = failed.filter((item) => item.severity === level)
            if (group.length === 0) {
                continue
            }
            lines.push(`### ${SEVERITY_LABEL[level]}`)
            lines.push("")
            for (const item of group) {
                lines.push(`#### ${item.id} ${item.name}`)
                lines.push("")
                const onlyFlag = item.id === undefined ? "" : " --only " + item.id
                lines.push("- 复现步骤：运行 `node scripts/e2e/run.mjs" + onlyFlag + "`；或看用例内步骤")
                lines.push(`- 期望：${item.expectation ?? "按 docs/ARCHITECTURE.md 约定"}`)
                lines.push(`- 实际：${String(item.error ?? "").trim() || "未知"}`)
                lines.push(`- 建议文件/接口：${item.hint ?? "见 docs/ARCHITECTURE.md 对应章节"}`)
                if (typeof item.logTail === "string" && item.logTail.trim() !== "") {
                    lines.push("- 宿主日志（失败时尾部）：")
                    lines.push("")
                    lines.push("```text")
                    lines.push(item.logTail.trim())
                    lines.push("```")
                }
                lines.push("")
            }
        }
    }
    if (skipped.length > 0) {
        lines.push("## 跳过")
        lines.push("")
        for (const item of skipped) {
            lines.push(`- ${item.id} ${item.name}：${item.skipReason ?? "未满足前置条件"}`)
        }
        lines.push("")
    }
    if (extra.screenshots !== undefined && extra.screenshots.length > 0) {
        lines.push("## 浏览器截图")
        lines.push("")
        for (const shot of extra.screenshots) {
            lines.push(`- ${shot.name}：\`${shot.file}\`${shot.note === undefined ? "" : `（${shot.note}）`}`)
        }
        lines.push("")
    }
    if (extra.browser !== undefined) {
        lines.push("## 浏览器检查")
        lines.push("")
        for (const item of extra.browser) {
            lines.push(`- ${item}`)
        }
        lines.push("")
    }
    if (extra.stubStats !== undefined) {
        lines.push("## Stub 模型统计")
        lines.push("")
        lines.push(`- chat 请求：${extra.stubStats.chatRequests ?? 0}，完成：${extra.stubStats.completions ?? 0}，中断：${extra.stubStats.aborted ?? 0}，500：${extra.stubStats.http500 ?? 0}，空回复：${extra.stubStats.emptyReplies ?? 0}`)
        lines.push(`- 场景计数：${JSON.stringify(extra.stubStats.byScenario ?? {})}`)
        lines.push("")
    }
    if (extra.advisories !== undefined && extra.advisories.length > 0) {
        lines.push("## 观察与建议（未判失败）")
        lines.push("")
        for (const item of extra.advisories) {
            lines.push(`### ${item.severity} ${item.title}`)
            lines.push("")
            lines.push(`- 现象：${item.detail}`)
            lines.push(`- 建议：${item.hint ?? "见 docs/ARCHITECTURE.md"}`)
            lines.push("")
        }
    }
    if (extra.hostErrorLines !== undefined && extra.hostErrorLines.length > 0) {
        lines.push("## 宿主日志关键行")
        lines.push("")
        lines.push("```text")
        for (const line of extra.hostErrorLines) {
            lines.push(line)
        }
        lines.push("```")
        lines.push("")
    }
    if (extra.notes !== undefined && extra.notes !== "") {
        lines.push("## 备注")
        lines.push("")
        lines.push(extra.notes)
        lines.push("")
    }
    lines.push("## 宿主日志尾部")
    lines.push("")
    lines.push("```text")
    lines.push(harness.tailHostLog(30))
    lines.push("```")
    lines.push("")
    return `${lines.join("\n")}\n`
}

function escapeCell(text) {
    return String(text).replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 200)
}

/** 把失败项按严重度排序，返回是否含 P0 */
export function summarize(results) {
    const failed = results.filter((item) => item.status === "fail")
    return {
        total: results.length,
        passed: results.filter((item) => item.status === "pass").length,
        failed: failed.length,
        skipped: results.filter((item) => item.status === "skip").length,
        p0: failed.filter((item) => item.severity === "P0").map((item) => `${item.id} ${item.name}`),
        p1: failed.filter((item) => item.severity === "P1").map((item) => `${item.id} ${item.name}`),
        p2: failed.filter((item) => item.severity === "P2").map((item) => `${item.id} ${item.name}`),
    }
}

export function relativeShotPath(file) {
    return path.relative(process.cwd(), file)
}
