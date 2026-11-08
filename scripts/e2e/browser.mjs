/*
 * 浏览器验证：headless Chrome + CDP 真实交互
 *
 * 覆盖：网关入口 bootstrap → 新建会话 → 普通消息 → 工具行折叠/展开 →
 * ask 点选回答 → approval 批准/拒绝 → 流式中停止 → 刷新后自动续接 →
 * 暗色、窄屏 390×844、直连入口截图；控制台 JS/CSP 报错收集。
 *
 * 只使用 Node 原生模块；CDP 走 Node 26 自带全局 WebSocket。
 */

import { spawn, execFileSync } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { getFreePort } from "./harness.mjs"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const SLOW_TEXT = "这是一段慢速流式回复，用来测试停止、插话与断线续接。回复会分很多块，每块之间有间隔。"

export function findChrome() {
    if (process.env.E2E_CHROME !== undefined && process.env.E2E_CHROME !== "") {
        return process.env.E2E_CHROME
    }
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
        try {
            const found = execFileSync("which", [name], { encoding: "utf8" }).trim()
            if (found !== "") {
                return found
            }
        } catch {
            /* 试下一个 */
        }
    }
    return null
}

/** 清理此前测试残留的 Chrome（只匹配我们的临时 profile 前缀，不碰用户浏览器） */
function cleanupStaleChrome() {
    let cleaned = 0
    let entries = []
    try {
        entries = fs.readdirSync("/proc")
    } catch {
        return cleaned
    }
    for (const entry of entries) {
        if (!/^\d+$/.test(entry)) {
            continue
        }
        try {
            const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8")
            if (!cmdline.includes("wellspring-chrome-") || Number(entry) === process.pid) {
                continue
            }
            process.kill(Number(entry), "SIGKILL")
            cleaned += 1
        } catch {
            /* 进程已退出或无权限 */
        }
    }
    return cleaned
}

/* ------------------------------------------------------------------ */
/* 极简 CDP 客户端                                                     */
/* ------------------------------------------------------------------ */

class Cdp {
    constructor(wsUrl) {
        this.wsUrl = wsUrl
        this.ws = null
        this.nextId = 1
        this.pending = new Map()
        this.handlers = new Map()
        this.closed = false
    }

    async connect() {
        this.ws = new WebSocket(this.wsUrl)
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("CDP WebSocket 连接超时")), 10_000)
            this.ws.addEventListener("open", () => {
                clearTimeout(timer)
                resolve()
            })
            this.ws.addEventListener("error", (event) => {
                clearTimeout(timer)
                reject(new Error(`CDP WebSocket 错误：${event.message ?? ""}`))
            })
        })
        this.ws.addEventListener("message", (event) => {
            let message
            try {
                message = JSON.parse(String(event.data))
            } catch {
                return
            }
            if (message.id !== undefined) {
                const pending = this.pending.get(message.id)
                if (pending !== undefined) {
                    this.pending.delete(message.id)
                    if (message.error !== undefined) {
                        pending.reject(new Error(`${pending.method} 失败：${message.error.message}`))
                    } else {
                        pending.resolve(message.result)
                    }
                }
                return
            }
            if (typeof message.method === "string") {
                for (const handler of this.handlers.get(message.method) ?? []) {
                    try {
                        handler(message.params)
                    } catch {
                        /* 单个监听器异常不外抛 */
                    }
                }
            }
        })
        this.ws.addEventListener("close", () => {
            this.closed = true
            for (const pending of this.pending.values()) {
                pending.reject(new Error("CDP 连接已关闭"))
            }
            this.pending.clear()
        })
    }

    on(method, handler) {
        const list = this.handlers.get(method) ?? []
        list.push(handler)
        this.handlers.set(method, list)
    }

    send(method, params = {}, timeoutMs = 25_000) {
        if (this.closed) {
            return Promise.reject(new Error("CDP 连接已关闭"))
        }
        const id = this.nextId++
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id)
                reject(new Error(`${method} 超时`))
            }, timeoutMs)
            this.pending.set(id, {
                method,
                resolve: (value) => {
                    clearTimeout(timer)
                    resolve(value)
                },
                reject: (error) => {
                    clearTimeout(timer)
                    reject(error)
                },
            })
            this.ws.send(JSON.stringify({ id, method, params }))
        })
    }

    close() {
        try {
            this.ws?.close()
        } catch {
            /* 已关闭 */
        }
    }
}

/* ------------------------------------------------------------------ */
/* 浏览器驱动                                                          */
/* ------------------------------------------------------------------ */

async function launchChrome({ chromePath, port, userDataDir }) {
    const child = spawn(
        chromePath,
        [
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--hide-scrollbars",
            "--mute-audio",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-background-networking",
            "--disable-sync",
            "--disable-features=Translate",
            "--metrics-recording-only",
            "--force-device-scale-factor=1",
            "--remote-debugging-address=127.0.0.1",
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${userDataDir}`,
            "about:blank",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
    )
    let stderr = ""
    child.stderr.on("data", (chunk) => {
        stderr += chunk.toString()
    })
    const deadline = Date.now() + 20_000
    for (;;) {
        if (child.exitCode !== null) {
            throw new Error(`Chrome 启动失败（退出码 ${child.exitCode}）：${stderr.slice(-800)}`)
        }
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/list`)
            if (response.ok) {
                const targets = await response.json()
                const page = targets.find((target) => target.type === "page")
                if (page !== undefined) {
                    return { child, wsUrl: page.webSocketDebuggerUrl, stderr }
                }
            }
        } catch {
            /* 继续等 */
        }
        if (Date.now() > deadline) {
            child.kill("SIGKILL")
            throw new Error(`Chrome 调试端口未就绪：${stderr.slice(-800)}`)
        }
        await sleep(200)
    }
}

async function evaluate(cdp, expression) {
    const result = await cdp.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
    })
    if (result.exceptionDetails !== undefined) {
        const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "unknown"
        throw new Error(`页面脚本异常：${detail}`)
    }
    return result.result?.value
}

async function waitPage(cdp, expression, { timeoutMs = 20_000, intervalMs = 250, label = "页面条件" } = {}) {
    const deadline = Date.now() + timeoutMs
    let lastError = null
    for (;;) {
        try {
            const value = await evaluate(cdp, expression)
            if (value) {
                return value
            }
        } catch (error) {
            lastError = error
        }
        if (Date.now() >= deadline) {
            const detail = lastError === null ? "" : `（最后错误：${lastError.message}）`
            throw new Error(`${label}超时（${timeoutMs}ms）${detail}`)
        }
        await sleep(intervalMs)
    }
}

async function navigate(cdp, url, { settleMs = 1_500 } = {}) {
    await cdp.send("Page.navigate", { url })
    await sleep(settleMs)
}

async function capture(cdp, file) {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })
    const buffer = Buffer.from(shot.data, "base64")
    await fsp.writeFile(file, buffer)
    return { file, bytes: buffer.length }
}

/** 页面基础状态：标题、可见文字、布局、输入区 */
async function pageSnapshot(cdp) {
    return await evaluate(
        cdp,
        `(() => {
            const text = (document.body.innerText || "").trim()
            const style = getComputedStyle(document.body)
            const send = document.querySelector(".composer__send")
            return {
                title: document.title,
                url: location.href,
                textLen: text.length,
                textHead: text.slice(0, 600),
                text,
                appReady: document.querySelector(".app") !== null,
                inputReady: document.querySelector(".composer__input") !== null,
                sendLabel: send === null ? null : send.getAttribute("aria-label"),
                messageCount: document.querySelectorAll(".thread__messages .msg").length,
                emptyState: document.querySelector(".thread__empty") !== null,
                bootError: document.querySelector(".boot--error") === null
                    ? null
                    : (document.querySelector(".boot__error")?.innerText ?? "初始化失败"),
                convCount: document.querySelectorAll(".conv").length,
                bodyBg: style.backgroundColor,
                bodyColor: style.color,
                scrollWidth: document.documentElement.scrollWidth,
                innerWidth: window.innerWidth,
                innerHeight: window.innerHeight,
                suggestions: document.querySelectorAll(".thread__suggestion").length,
                newButton: document.querySelector(".sidebar__new") !== null,
            }
        })()`,
    )
}

function luminance(color) {
    const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color ?? "")
    if (match === null) {
        return null
    }
    return (Number(match[1]) * 299 + Number(match[2]) * 587 + Number(match[3]) * 114) / 1000
}

/** 页面内同源 fetch，验证网关路径下的 API 可用性 */
async function pageFetchJson(cdp, pathname) {
    return await evaluate(
        cdp,
        `(async () => {
            const response = await fetch(${JSON.stringify(pathname)}, { headers: { accept: "application/json" } })
            const text = await response.text()
            let json = null
            try { json = JSON.parse(text) } catch {}
            return { status: response.status, json, text: text.slice(0, 500) }
        })()`,
    )
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 运行浏览器检查（真实 UI 交互）
 *
 * @param {object} input
 * @param {object} input.harness 已启动 harness
 * @param {string} input.shotsDir 截图目录
 * @param {string} [input.runId] 截图子目录
 * @param {boolean} [input.interaction] 是否跑真实交互场景（后端就绪时）
 * @param {string} [input.replyText] 普通场景期望回复
 */
export async function runBrowserChecks({
    harness,
    shotsDir,
    runId,
    interaction = false,
    replyText = "你好，我是测试模型。",
}) {
    const chromePath = findChrome()
    if (chromePath === null) {
        throw new Error("没有找到 google-chrome / chromium，可设 E2E_CHROME 指定")
    }
    const staleKilled = cleanupStaleChrome()
    const outDir = path.join(shotsDir, runId)
    await fsp.mkdir(outDir, { recursive: true })
    const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "wellspring-chrome-"))
    const screenshots = []
    const checks = []
    const consoleErrors = []
    const failedRequests = []
    const chatResponses = []
    let resizeAdvisory = null
    let chrome = null
    let cdp = null
    let phase = "init"
    const addCheck = (name, pass, detail = "") => {
        checks.push({ name, pass, detail })
    }
    const shot = async (name, file, note = "") => {
        const result = await capture(cdp, path.join(outDir, file))
        screenshots.push({ name, file: result.file, note: `${note}${note === "" ? "" : "；"}${Math.round(result.bytes / 1024)}KB` })
        return result
    }

    /* ---------------- 页面操作辅助 ---------------- */

    const clickSelector = async (selector) => {
        const clicked = await evaluate(
            cdp,
            `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el === null) return false; el.click(); return true })()`,
        )
        if (!clicked) {
            throw new Error(`找不到元素 ${selector}`)
        }
    }
    const clickByText = async (selector, text) => {
        const clicked = await evaluate(
            cdp,
            `(() => {
                const hit = [...document.querySelectorAll(${JSON.stringify(selector)})]
                    .find((el) => (el.textContent || "").includes(${JSON.stringify(text)}))
                if (hit === undefined) return false
                hit.click()
                return true
            })()`,
        )
        if (!clicked) {
            throw new Error(`找不到 ${selector} 中包含「${text}」的元素`)
        }
    }
    const startNewConversation = async () => {
        const clicked = await evaluate(
            cdp,
            `(() => { const button = document.querySelector(".sidebar__new"); if (button === null) return false; button.click(); return true })()`,
        )
        if (!clicked) {
            throw new Error("找不到「新对话」按钮 .sidebar__new")
        }
        await sleep(700)
        await waitPage(cdp, `document.querySelector(".composer__input") !== null`, {
            timeoutMs: 10_000,
            label: "新会话输入区",
        })
    }
    const typeAndSend = async (text) => {
        const found = await evaluate(
            cdp,
            `(() => {
                const el = document.querySelector(".composer__input")
                if (el === null) return null
                el.focus()
                return { tag: el.tagName, placeholder: el.getAttribute("placeholder") ?? "" }
            })()`,
        )
        if (found === null) {
            throw new Error("页面没有找到输入框 .composer__input")
        }
        await cdp.send("Input.insertText", { text })
        await sleep(200)
        let typed = await evaluate(cdp, `document.querySelector(".composer__input").value.length`)
        if (!(typed > 0)) {
            typed = await evaluate(
                cdp,
                `(() => {
                    const el = document.querySelector(".composer__input")
                    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set
                    setter.call(el, ${JSON.stringify(text)})
                    el.dispatchEvent(new Event("input", { bubbles: true }))
                    return el.value.length
                })()`,
            )
        }
        const clicked = await evaluate(
            cdp,
            `(() => {
                const send = document.querySelector(".composer__send")
                if (send === null || send.disabled) return false
                send.click()
                return true
            })()`,
        )
        if (!clicked) {
            await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
            await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
        }
        return { typed, clicked }
    }
    const waitForText = async (text, timeoutMs = 45_000) => {
        await waitPage(
            cdp,
            `(document.body.innerText || "").includes(${JSON.stringify(text)})`,
            { timeoutMs, label: `正文「${text.slice(0, 24)}」出现` },
        )
    }
    const waitStreamSettled = async (timeoutMs = 60_000) => {
        await waitPage(
            cdp,
            `(() => {
                const send = document.querySelector(".composer__send")
                return send !== null
                    && send.getAttribute("aria-label") === "发送"
                    && document.querySelectorAll('[aria-label="停止本轮"]').length === 0
            })()`,
            { timeoutMs, label: "流式结束、输入区恢复" },
        )
    }
    const runStep = async (name, fn) => {
        try {
            const detail = await fn()
            addCheck(name, true, detail ?? "")
            return true
        } catch (error) {
            let detail = error instanceof Error ? error.message : String(error)
            /* 失败现场截图 + 页面文字，方便报告定位 */
            try {
                const failedSnapshot = await pageSnapshot(cdp)
                detail = `${detail}；页面文字：${failedSnapshot.textHead.slice(0, 300).replace(/\n/g, " ")}`
                const slug = name.replace(/[^\w\u4e00-\u9fff]+/g, "-").slice(0, 40)
                await shot(`失败现场-${name}`, `fail-${slug}.png`, detail.slice(0, 120))
            } catch {
                /* 截图失败不影响记录 */
            }
            /* 恢复：停掉仍在跑的轮次并刷新页面，避免拖垮后续场景 */
            try {
                const streaming = await evaluate(
                    cdp,
                    `document.querySelector('[aria-label="停止本轮"]') !== null`,
                )
                if (streaming) {
                    await clickSelector('[aria-label="停止本轮"]')
                    await sleep(600)
                }
            } catch {
                /* 忽略恢复失败 */
            }
            try {
                await cdp.send("Page.reload", { ignoreCache: false })
                await sleep(1_500)
                await waitPage(
                    cdp,
                    `document.querySelector(".app") !== null || document.querySelector(".boot--error") !== null`,
                    { timeoutMs: 20_000, label: "失败恢复后页面就绪" },
                )
            } catch {
                /* 忽略恢复失败 */
            }
            addCheck(name, false, detail)
            return false
        }
    }

    /* ---------------- 启动 Chrome / CDP ---------------- */

    try {
        let launchError = null
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const debugPort = await getFreePort()
            try {
                chrome = await launchChrome({ chromePath, port: debugPort, userDataDir })
                launchError = null
                break
            } catch (error) {
                launchError = error
                await sleep(400)
            }
        }
        if (chrome === null) {
            throw launchError ?? new Error("Chrome 启动失败")
        }
        cdp = new Cdp(chrome.wsUrl)
        await cdp.connect()
        await cdp.send("Page.enable")
        await cdp.send("Runtime.enable")
        await cdp.send("Log.enable")
        await cdp.send("Network.enable")

        cdp.on("Runtime.consoleAPICalled", (params) => {
            if (params.type === "error") {
                consoleErrors.push({
                    kind: "console.error",
                    phase,
                    text: params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "),
                })
            }
        })
        cdp.on("Runtime.exceptionThrown", (params) => {
            consoleErrors.push({
                kind: "exception",
                phase,
                text: params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "",
            })
        })
        cdp.on("Log.entryAdded", (params) => {
            const entry = params.entry ?? {}
            if (entry.level === "error") {
                consoleErrors.push({ kind: `log.${entry.source ?? "unknown"}`, phase, text: entry.text ?? "" })
            }
        })
        cdp.on("Network.responseReceived", (params) => {
            const response = params.response ?? {}
            const url = response.url ?? ""
            if (url.includes("/api/") && url.includes("/chat")) {
                chatResponses.push(response.status)
            }
            if (response.status >= 400) {
                failedRequests.push({ status: response.status, url })
            }
        })
        cdp.on("Network.loadingFailed", (params) => {
            failedRequests.push({ status: 0, url: params.requestId ?? "", error: params.errorText })
        })

        const base = harness.gatewayReady ? harness.gatewayUrl("/web/") : harness.url("/")
        const baseUrl = base.endsWith("/") ? base : `${base}/`

        /* 网关入口 bootstrap */
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
        await navigate(cdp, baseUrl, { settleMs: 800 })
        let boot = null
        try {
            boot = await waitPage(
                cdp,
                `(() => {
                    const error = document.querySelector(".boot--error")
                    if (error !== null) return { error: (error.innerText || "").trim().slice(0, 300) }
                    if (document.querySelector(".app") !== null && document.querySelector(".composer__input") !== null) return { ready: true }
                    return null
                })()`,
                { timeoutMs: 30_000, label: "bootstrap 完成（.app 与输入区出现）" },
            )
        } catch (error) {
            const snapshot = await pageSnapshot(cdp).catch(() => null)
            throw new Error(`${error.message}；页面快照：${JSON.stringify(snapshot)?.slice(0, 500) ?? "无"}`)
        }
        let snapshot = await pageSnapshot(cdp)
        addCheck(
            "页面可渲染（无白屏）",
            snapshot.textLen > 0 || snapshot.appReady,
            `文字 ${snapshot.textLen} 字，app=${snapshot.appReady}`,
        )
        if (boot?.error !== undefined && harness.backendReady) {
            throw new Error(`页面 bootstrap 失败：${boot.error}`)
        }
        addCheck(
            "bootstrap 完成（侧栏/输入区出现）",
            snapshot.appReady && snapshot.inputReady,
            boot?.error !== undefined ? `后端未就绪阶段错误态：${boot.error}` : `会话数 ${snapshot.convCount}，建议卡 ${snapshot.suggestions}`,
        )

        if (interaction) {
            /* 前端默认新会话权限是 workspace-write；改为 read-only 才能触发审批场景 */
            await evaluate(
                cdp,
                `(() => { try { localStorage.setItem("wellspring.web.permission", "read-only") } catch {} return true })()`,
            )
            await cdp.send("Page.reload", { ignoreCache: false })
            await sleep(1_200)
            await waitPage(
                cdp,
                `document.querySelector(".app") !== null && document.querySelector(".composer__input") !== null`,
                { timeoutMs: 30_000, label: "设置默认权限后页面就绪" },
            )

            /* 1. 普通对话 */
            await runStep("新建会话并完成普通对话", async () => {
                await startNewConversation()
                const empty = await pageSnapshot(cdp)
                if (!empty.emptyState && empty.messageCount > 0) {
                    throw new Error("新建会话后不是空状态")
                }
                await typeAndSend("浏览器里发一条消息 [[stub:text]]")
                await waitForText(replyText)
                await waitStreamSettled()
                const after = await pageSnapshot(cdp)
                if (after.messageCount < 2) {
                    throw new Error(`消息条数不足：${after.messageCount}`)
                }
                if (after.convCount < 1) {
                    throw new Error("侧栏没有出现会话条目")
                }
                const list = await pageFetchJson(cdp, "api/conversations")
                const hit = [...(list.json?.conversations ?? [])]
                    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
                    .find((item) => (item.last?.text ?? "").includes(replyText) || (item.title ?? "").includes("浏览器里发"))
                if (hit === undefined) {
                    throw new Error("会话没有落到后端列表")
                }
                const detail = await pageFetchJson(cdp, `api/conversations/${hit.id}`)
                const messages = detail.json?.conversation?.messages ?? []
                if (!messages.some((message) => message.role === "assistant" && (message.text ?? "").includes(replyText))) {
                    throw new Error("后端会话记录缺少助手回复")
                }
                await shot("普通对话", "chat-reply-1440x900.png", `会话 ${hit.id}`)
                return `消息 ${after.messageCount} 条，会话 ${after.convCount} 个`
            })

            /* 2. 工具行折叠/展开 */
            await runStep("工具行折叠与展开", async () => {
                await startNewConversation()
                await typeAndSend("执行命令 [[stub:tool]]")
                await waitPage(cdp, `document.querySelectorAll(".tool").length > 0`, {
                    timeoutMs: 20_000,
                    label: "工具行出现",
                })
                await waitForText("工具已执行完毕。")
                await waitStreamSettled()
                const openBefore = await evaluate(cdp, `document.querySelector(".tool--open") !== null`)
                if (openBefore) {
                    await clickSelector(".tool__head")
                }
                await waitPage(cdp, `document.querySelector(".tool__panel") === null`, { label: "工具行收起" })
                await shot("工具行（折叠）", "tool-collapsed-1440x900.png", "含成功状态圆点")
                await clickSelector(".tool__head")
                await waitPage(cdp, `document.querySelector(".tool__panel") !== null`, { label: "工具行展开" })
                const panelText = await evaluate(cdp, `document.querySelector(".tool__panel")?.innerText ?? ""`)
                if (!panelText.includes("参数") || !panelText.includes("输出")) {
                    throw new Error(`工具面板缺少参数/输出：${panelText.slice(0, 200)}`)
                }
                await shot("工具行（展开）", "tool-expanded-1440x900.png", "参数与输出可见")
                return "折叠/展开截图完成"
            })

            /* 3. ask 点选回答 */
            await runStep("ask 在 UI 中回答并继续", async () => {
                await startNewConversation()
                await typeAndSend("问我 [[stub:ask]]")
                await waitPage(cdp, `document.querySelectorAll(".ask__option").length >= 2`, {
                    timeoutMs: 20_000,
                    label: "ask 选项出现",
                })
                await shot("提问卡片", "ask-pending-1440x900.png", "两个选项")
                await clickByText(".ask__option", "选项甲")
                await sleep(150)
                const enabled = await evaluate(
                    cdp,
                    `(() => { const button = document.querySelector(".ask__actions .btn--primary"); return button !== null && !button.disabled })()`,
                )
                if (!enabled) {
                    throw new Error("选中选项后提交按钮仍禁用")
                }
                await clickSelector(".ask__actions .btn--primary")
                await waitForText("收到回答，流程结束。")
                await waitStreamSettled()
                const result = await evaluate(cdp, `document.querySelector(".ask__result")?.innerText ?? ""`)
                if (!result.includes("已回答") || !result.includes("选项甲")) {
                    throw new Error(`ask 结果未展示回答：${result}`)
                }
                await shot("ask 已回答", "ask-answered-1440x900.png", result.replace(/\n/g, " "))
                return "已点选选项甲并继续到 done"
            })

            /* 4. approval 批准 / 拒绝 */
            await runStep("approval 批准后继续", async () => {
                await startNewConversation()
                await typeAndSend("提权测试 [[stub:approval]]")
                await waitPage(cdp, `document.querySelector(".approval__actions .btn--primary") !== null`, {
                    timeoutMs: 20_000,
                    label: "审批卡片出现",
                })
                const change = await evaluate(cdp, `document.querySelector(".approval .badge--warn")?.innerText ?? ""`)
                if (!change.includes("→")) {
                    throw new Error(`审批权限变化未展示：${change}`)
                }
                await shot("审批卡片", "approval-pending-1440x900.png", change)
                await clickSelector(".approval__actions .btn--primary")
                await waitForText("提权流程结束。")
                await waitStreamSettled()
                const result = await evaluate(cdp, `document.querySelector(".approval__result")?.innerText ?? ""`)
                if (!result.includes("已批准")) {
                    throw new Error(`审批结果未展示已批准：${result}`)
                }
                await shot("审批已批准", "approval-approved-1440x900.png", result.replace(/\n/g, " "))
                return "批准后继续到 done"
            })

            await runStep("approval 拒绝后继续", async () => {
                await startNewConversation()
                await typeAndSend("提权测试 [[stub:approval]]")
                await waitPage(cdp, `document.querySelector(".approval__actions .btn--danger") !== null`, {
                    timeoutMs: 20_000,
                    label: "审批卡片出现（拒绝）",
                })
                await clickSelector(".approval__actions .btn--danger")
                await waitForText("提权流程结束。")
                await waitStreamSettled()
                const result = await evaluate(cdp, `document.querySelector(".approval__result")?.innerText ?? ""`)
                if (!result.includes("已拒绝")) {
                    throw new Error(`审批结果未展示已拒绝：${result}`)
                }
                await shot("审批已拒绝", "approval-denied-1440x900.png", result.replace(/\n/g, " "))
                return "拒绝后继续到 done"
            })

            /* 5. 流式中停止 */
            await runStep("流式中停止", async () => {
                await startNewConversation()
                await typeAndSend("慢速 [[stub:slow:250]]")
                await waitPage(cdp, `document.querySelector('[aria-label="停止本轮"]') !== null`, {
                    timeoutMs: 20_000,
                    label: "停止按钮出现",
                })
                await sleep(700)
                await clickSelector('[aria-label="停止本轮"]')
                await waitPage(cdp, `(document.body.innerText || "").includes("已停止")`, {
                    timeoutMs: 20_000,
                    label: "停止态出现",
                })
                await waitStreamSettled(20_000)
                const stopped = await evaluate(
                    cdp,
                    `(() => ({
                        state: document.querySelector(".msg__state")?.innerText ?? "",
                        text: [...document.querySelectorAll(".thread__messages .msg")]
                            .map((el) => el.innerText || "")
                            .join(" | "),
                        fullText: document.body.innerText,
                    }))()`,
                )
                if (!stopped.fullText.includes("已停止")) {
                    throw new Error("停止后页面没有「已停止」标记")
                }
                await shot("流式中停止", "stop-stopped-1440x900.png", "已显示停止态")
                return `停止态已显示（正文 ${stopped.text.length} 字）`
            })

            /* 6. 错误后重试按钮 */
            await runStep("错误后点重试", async () => {
                await startNewConversation()
                await typeAndSend("故意报错 [[stub:500]]")
                await waitPage(cdp, `document.querySelector(".msg__alert-action") !== null`, {
                    timeoutMs: 25_000,
                    label: "错误态重试按钮出现",
                })
                const errorText = await evaluate(cdp, `document.querySelector(".msg__alert-text")?.innerText ?? ""`)
                if (!/[\u4e00-\u9fff]/.test(errorText)) {
                    throw new Error(`错误信息不是中文：${errorText}`)
                }
                await shot("错误态与重试按钮", "error-retry-1440x900.png", errorText)
                const before = await evaluate(cdp, `document.querySelectorAll(".thread__messages .msg").length`)
                await clickSelector(".msg__alert-action")
                await waitPage(
                    cdp,
                    `document.querySelectorAll(".thread__messages .msg").length > ${before}`,
                    { timeoutMs: 25_000, label: "重试后新一轮出现" },
                )
                await waitPage(cdp, `document.querySelector(".msg__alert-action") !== null`, {
                    timeoutMs: 25_000,
                    label: "重试后错误态再次出现",
                })
                return `重试前 ${before} 条消息，重试后再次失败并给出中文错误`
            })

            /* 7. 长文本流式自动跟随底部 */
            await runStep("长文本自动跟随底部", async () => {
                await startNewConversation()
                await typeAndSend("长文本 [[stub:long]]")
                await waitPage(cdp, `document.body.innerText.includes("第 120 行")`, {
                    timeoutMs: 40_000,
                    label: "长文本渲染完成",
                })
                await waitStreamSettled(30_000)
                const follow = await evaluate(
                    cdp,
                    `(() => {
                        const el = document.querySelector(".thread__scroll")
                        if (el === null) return null
                        return { distance: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), scrollHeight: el.scrollHeight }
                    })()`,
                )
                if (follow === null) {
                    throw new Error("找不到对话滚动容器 .thread__scroll")
                }
                if (follow.distance > 48) {
                    throw new Error(`流式结束后未跟随到底部：距底部 ${follow.distance}px（scrollHeight ${follow.scrollHeight}）`)
                }
                await shot("长文本自动跟随", "long-autofollow-1440x900.png", `距底部 ${follow.distance}px`)
                return `距底部 ${follow.distance}px，scrollHeight ${follow.scrollHeight}`
            })

            /* 8. ask 跳过 */
            await runStep("ask 跳过", async () => {
                await startNewConversation()
                await typeAndSend("问我 [[stub:ask]]")
                await waitPage(cdp, `document.querySelector(".ask__actions .btn--ghost") !== null`, {
                    timeoutMs: 20_000,
                    label: "ask 跳过按钮出现",
                })
                await clickSelector(".ask__actions .btn--ghost")
                await waitForText("收到回答，流程结束。")
                await waitStreamSettled()
                const result = await evaluate(cdp, `document.querySelector(".ask__result")?.innerText ?? ""`)
                if (!result.includes("已跳过")) {
                    throw new Error(`ask 跳过结果未展示：${result}`)
                }
                await shot("ask 已跳过", "ask-skipped-1440x900.png", result.replace(/\n/g, " "))
                return "跳过提问后宿主继续到 done"
            })

            /* 9. 刷新断开后自动续接 */
            await runStep("刷新断开后自动续接", async () => {
                phase = "resume"
                await startNewConversation()
                await typeAndSend("续接测试 [[stub:slow:300]]")
                await waitForText(SLOW_TEXT.slice(0, 8), 20_000)
                await sleep(400)
                /* 记录当前运行会话，刷新后按需用 hash 打开 */
                const running = await pageFetchJson(cdp, "api/running")
                const bootstrap = await pageFetchJson(cdp, "api/bootstrap")
                const conversationId =
                    running.json?.running?.[0]?.conversationId ?? bootstrap.json?.activeId ?? null
                /* 刷新 = 浏览器取消 SSE：走前端「页面加载 → resume」恢复路径 */
                await cdp.send("Page.reload", { ignoreCache: false })
                await sleep(1_500)
                await waitPage(cdp, `document.querySelector(".composer__input") !== null`, {
                    timeoutMs: 30_000,
                    label: "刷新后页面就绪",
                })
                try {
                    await waitForText(SLOW_TEXT, 12_000)
                } catch {
                    if (conversationId === null) {
                        throw new Error("刷新后没有自动打开运行中的会话，且拿不到会话 id")
                    }
                    await navigate(cdp, `${baseUrl}#/c/${conversationId}`, { settleMs: 1_000 })
                    await waitForText(SLOW_TEXT, 30_000)
                }
                await waitStreamSettled(30_000)
                const messages = await evaluate(cdp, `document.querySelectorAll(".thread__messages .msg").length`)
                if (messages < 2) {
                    throw new Error(`续接后消息条数不足：${messages}`)
                }
                await shot("刷新后自动续接", "resume-completed-1440x900.png", "完整正文已恢复")
                phase = "normal"
                return "刷新后自动 resume 并收到完整正文"
            })

            /* 10. 暗色与窄屏 */
            phase = "theme"
            await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] })
            await sleep(700)
            let darkSnapshot = await pageSnapshot(cdp)
            let darkLuma = luminance(darkSnapshot.bodyBg)
            if (darkLuma === null || darkLuma >= 120) {
                await cdp.send("Page.reload", { ignoreCache: false })
                await sleep(2_000)
                await waitPage(cdp, `document.querySelector(".app") !== null || document.querySelector(".boot") !== null`, {
                    timeoutMs: 20_000,
                    label: "暗色刷新后页面就绪",
                })
                await sleep(800)
                darkSnapshot = await pageSnapshot(cdp)
                darkLuma = luminance(darkSnapshot.bodyBg)
            }
            await shot("暗色主题", "dark-1440x900.png", `背景 ${darkSnapshot.bodyBg}`)
            addCheck("暗色主题生效", darkLuma !== null && darkLuma < 120, `body 背景 ${darkSnapshot.bodyBg}（亮度 ${darkLuma === null ? "未知" : Math.round(darkLuma)}）`)

            await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] })
            await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
            /* 真实移动端语义：以窄屏宽度重新加载，避免桌面 resize 带出的抽屉状态 */
            await cdp.send("Page.reload", { ignoreCache: false })
            await sleep(1_800)
            await waitPage(cdp, `document.querySelector(".app") !== null || document.querySelector(".boot") !== null`, {
                timeoutMs: 25_000,
                label: "窄屏刷新后页面就绪",
            }).catch(() => {})
            await sleep(600)
            const narrowSnapshot = await pageSnapshot(cdp)
            await shot("窄屏", "narrow-390x844.png", `scrollWidth ${narrowSnapshot.scrollWidth}`)
            addCheck(
                "窄屏无横向溢出",
                narrowSnapshot.scrollWidth <= narrowSnapshot.innerWidth + 2,
                `scrollWidth ${narrowSnapshot.scrollWidth} / innerWidth ${narrowSnapshot.innerWidth}`,
            )
            addCheck("窄屏输入区可用", narrowSnapshot.inputReady, `输入区=${narrowSnapshot.inputReady}`)

            /* 11. 直连入口 */
            /* 桌面 → 窄屏 resize 时，桌面默认展开的「上下文」会变成盖住对话的底部 sheet */
            try {
                await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
                await cdp.send("Page.reload", { ignoreCache: false })
                await sleep(1_800)
                await waitPage(cdp, `document.querySelector(".app") !== null`, { timeoutMs: 20_000, label: "桌面重新加载" })
                await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
                await sleep(700)
                const inspectorOpen = await evaluate(
                    cdp,
                    `(() => {
                        const el = document.querySelector(".inspector")
                        if (el === null) return false
                        const style = getComputedStyle(el)
                        return style.display !== "none" && style.visibility !== "hidden"
                            && (style.transform === "none" || style.transform === "matrix(1, 0, 0, 1, 0, 0)")
                            && el.getBoundingClientRect().height > 100
                    })()`,
                )
                if (inspectorOpen) {
                    resizeAdvisory = {
                        severity: "P2",
                        title: "桌面缩到窄屏时「上下文」底部 sheet 未自动收起",
                        detail: "桌面默认展开 Inspector；窗口缩到 <1024px 后它变成底部 sheet 盖住对话（本次从 1440 缩到 390 复现）",
                        hint: "frontend/src/App.vue 的 onResize：窄屏时也调用 closeDrawers()，或监听 matchMedia 变化关闭抽屉",
                    }
                }
            } catch {
                /* 观察项失败不影响主用例 */
            }

            await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
            await navigate(cdp, harness.url("/"), { settleMs: 1_500 })
            try {
                await waitPage(
                    cdp,
                    `document.querySelector(".app") !== null || document.querySelector(".boot--error") !== null`,
                    { timeoutMs: 20_000, label: "直连入口页面就绪" },
                )
            } catch {
                /* 由快照断言兜底 */
            }
            const directSnapshot = await pageSnapshot(cdp)
            await shot("直连入口", "direct-1440x900.png", "直连端口")
            addCheck(
                "直连端口可渲染",
                directSnapshot.appReady || directSnapshot.textLen > 0,
                `appReady=${directSnapshot.appReady}，文字 ${directSnapshot.textLen} 字`,
            )

            /* 12. 汇总断言 */
            const chatOk = chatResponses.length > 0 && chatResponses.every((status) => status === 200)
            addCheck(
                "SSE chat 响应均为 200",
                chatOk,
                `chat 响应状态：${JSON.stringify(chatResponses)}`,
            )
            const expectedNetwork = /ERR_ABORTED|ERR_INTERNET_DISCONNECTED|Failed to fetch|NetworkError|net::/i
            const relevantConsoleErrors = consoleErrors.filter((item) => {
                if (!harness.backendReady && item.kind.startsWith("log.")) {
                    return false
                }
                /* 刷新断开时的网络中止属于预期，不算 JS/CSP 报错 */
                if (item.phase === "resume" && expectedNetwork.test(item.text)) {
                    return false
                }
                return true
            })
            const assetFailures = failedRequests.filter((item) => item.status >= 400 && !item.url.includes("/api/"))
            addCheck(
                "控制台无 JS/CSP 报错",
                relevantConsoleErrors.length === 0,
                relevantConsoleErrors.map((item) => `[${item.phase}] ${item.kind}: ${item.text}`).join("；").slice(0, 800),
            )
            addCheck(
                "静态资源无 4xx/5xx",
                assetFailures.length === 0,
                assetFailures.map((item) => `${item.status} ${item.url}`).join("；").slice(0, 600),
            )
            const smallShots = screenshots.filter((item) => !fs.existsSync(item.file) || fs.statSync(item.file).size < 2_000)
            addCheck(
                "截图完整",
                smallShots.length === 0,
                smallShots.length === 0 ? `${screenshots.length} 张` : smallShots.map((item) => item.file).join("，"),
            )
        } else {
            /* 后端未就绪：只截基础渲染 */
            await shot("基础渲染", "boot-direct-1440x900.png", "后端未就绪")
            const relevantConsoleErrors = consoleErrors.filter((item) => !item.kind.startsWith("log."))
            addCheck(
                "控制台无 JS/CSP 报错",
                relevantConsoleErrors.length === 0,
                relevantConsoleErrors.map((item) => `${item.kind}: ${item.text}`).join("；").slice(0, 500),
            )
        }

        return {
            chrome: chromePath,
            base: baseUrl,
            staleKilled,
            checks,
            consoleErrors,
            failedRequests: failedRequests.slice(0, 40),
            screenshots,
            interaction: { ran: interaction, phases: ["普通对话", "工具", "ask", "审批批准", "审批拒绝", "停止", "续接"] },
            advisories: resizeAdvisory === null ? [] : [resizeAdvisory],
            snapshots: { desktop: snapshot },
        }
    } finally {
        cdp?.close()
        if (chrome !== null) {
            chrome.child.kill("SIGTERM")
            await sleep(400)
            if (chrome.child.exitCode === null) {
                chrome.child.kill("SIGKILL")
            }
        }
        await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
    }
}
