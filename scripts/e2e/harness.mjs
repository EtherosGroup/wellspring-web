#!/usr/bin/env node
/*
 * e2e 隔离宿主：临时 home、端口、stub 模型与服务进程的启停
 *
 * 每次运行生成独立 home（/tmp/wellspring-web-e2e-*）与独立端口，
 * 不触碰用户主实例（8780/8787）与其它测试实例。
 *
 * 单独运行：node scripts/e2e/harness.mjs [--keep]
 * 启动后打印直连/网关地址，Ctrl+C 退出并清理。
 */

import { spawn } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const E2E_DIR = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(E2E_DIR, "../..")
export const STUB_SCRIPT = path.join(E2E_DIR, "stub-model.mjs")
export const DEFAULT_REPORT = "/tmp/e2e-report.md"
export const DEFAULT_SHOTS_DIR = "/tmp/e2e-shots"
const GATEWAY_PLUGIN_DEFAULT = path.resolve(REPO_ROOT, "../wellspring-gateway")
const CORE_PLUGIN_CANDIDATES = [
    process.env.E2E_CORE_PLUGIN,
    path.join(os.homedir(), ".local/share/wellspring/plugins/wellspring-core"),
].filter((item) => typeof item === "string" && item !== "")

/** 取一个空闲 loopback 端口；两次运行之间仍可能被抢占，失败时换端口重试即可 */
export async function getFreePort() {
    return await new Promise((resolve, reject) => {
        const server = net.createServer()
        server.unref()
        server.on("error", reject)
        server.listen(0, "127.0.0.1", () => {
            const address = server.address()
            const port = typeof address === "object" && address !== null ? address.port : null
            server.close(() => {
                if (port === null) {
                    reject(new Error("取空闲端口失败"))
                } else {
                    resolve(port)
                }
            })
        })
    })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 轮询直到回调返回真值；超时抛错并带标签 */
export async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 250, label = "等待" } = {}) {
    const deadline = Date.now() + timeoutMs
    let lastError = null
    while (Date.now() < deadline) {
        try {
            const value = await fn()
            if (value) {
                return value
            }
        } catch (error) {
            lastError = error
        }
        await sleep(intervalMs)
    }
    const detail = lastError === null ? "" : `（最后错误：${lastError instanceof Error ? lastError.message : String(lastError)}）`
    throw new Error(`${label}超时（${timeoutMs}ms）${detail}`)
}

async function fetchJson(url, { timeoutMs = 5_000 } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const response = await fetch(url, { signal: controller.signal })
        const text = await response.text()
        let json = null
        try {
            json = JSON.parse(text)
        } catch {
            /* 非 JSON 响应按 null 处理 */
        }
        return { status: response.status, headers: response.headers, text, json }
    } finally {
        clearTimeout(timer)
    }
}

export function findCorePlugin(explicit = null) {
    const candidates = [...(explicit === null ? [] : [explicit]), ...CORE_PLUGIN_CANDIDATES]
    for (const candidate of candidates) {
        try {
            if (fs.statSync(candidate).isDirectory()) {
                return candidate
            }
        } catch {
            /* 继续找下一个 */
        }
    }
    return null
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(value, null, 4)}\n`, { mode: 0o600 })
}

/**
 * 创建隔离环境；prepare() 前不会启动任何进程
 *
 * @param {object} [options]
 * @param {string} [options.home]        复用已有 home（默认新建临时目录）
 * @param {number} [options.gatewayPort] 网关端口（默认动态）
 * @param {number} [options.webPort]     插件直连端口（默认动态）
 * @param {number} [options.stubPort]    stub 模型端口（默认动态）
 * @param {string} [options.gatewayPlugin] 网关插件目录
 * @param {string} [options.corePlugin]  核心工具插件目录；缺省自动发现
 * @param {boolean} [options.linkCore]   是否链接核心工具插件（默认 true）
 */
export function createHarness(options = {}) {
    return new Harness(options)
}

class Harness {
    constructor(options) {
        this.options = options
        this.home = options.home ?? null
        this.workDir = null
        this.ports = {
            gateway: options.gatewayPort ?? null,
            web: options.webPort ?? null,
            stub: options.stubPort ?? null,
        }
        this.processes = { host: null, stub: null }
        this.logs = { host: [], stub: [], hostFile: null, stubFile: null }
        this.hostLogStream = null
        this.stubLogStream = null
        this.health = null
        this.gatewayReady = false
        this.backendReady = false
        this.startedAt = Date.now()
        this.gatewayPlugin = options.gatewayPlugin ?? GATEWAY_PLUGIN_DEFAULT
        this.corePlugin = options.corePlugin === undefined ? findCorePlugin() : options.corePlugin
        this.linkCore = options.linkCore !== false && this.corePlugin !== null
    }

    get repoRoot() {
        return REPO_ROOT
    }

    get webBase() {
        return `http://127.0.0.1:${this.ports.web}`
    }

    /** 网关地址（含 /web 前缀由 paths 决定） */
    get gatewayBase() {
        return `http://127.0.0.1:${this.ports.gateway}`
    }

    url(pathname = "/") {
        return `${this.webBase}${pathname}`
    }

    gatewayUrl(pathname = "/web/") {
        return `${this.gatewayBase}${pathname}`
    }

    async prepare() {
        if (this.home === null) {
            this.home = await fsp.mkdtemp(path.join(os.tmpdir(), "wellspring-web-e2e-"))
        }
        this.workDir = path.join(this.home, "work")
        this.logs.hostFile = path.join(this.home, "logs", "host.log")
        this.logs.stubFile = path.join(this.home, "logs", "stub.log")

        await fsp.mkdir(path.join(this.home, "config", "plugins"), { recursive: true })
        await fsp.mkdir(path.join(this.home, "data", "plugins"), { recursive: true })
        await fsp.mkdir(path.join(this.home, "cache"), { recursive: true })
        await fsp.mkdir(path.join(this.home, "logs"), { recursive: true })
        await fsp.mkdir(this.workDir, { recursive: true })

        for (const plugin of [
            { name: "wellspring-gateway", dir: this.gatewayPlugin },
            { name: "wellspring-web", dir: REPO_ROOT },
            ...(this.linkCore ? [{ name: "wellspring-core", dir: this.corePlugin }] : []),
        ]) {
            if (!fs.existsSync(plugin.dir)) {
                throw new Error(`插件目录不存在：${plugin.dir}`)
            }
            const target = path.join(this.home, "data", "plugins", plugin.name)
            await fsp.rm(target, { force: true })
            await fsp.symlink(plugin.dir, target, "dir")
        }

        /* 端口在配置写入前定好；网关端口 0 也可用，这里固定成动态端口便于断言 */
        this.ports.gateway ??= await getFreePort()
        this.ports.web ??= await getFreePort()
        this.ports.stub ??= await getFreePort()

        writeJson(path.join(this.home, "config", "app-setting.json"), {
            version: 1,
            logger: { level: "info" },
            openai: { baseUrl: null, model: "stub-1", timeoutMs: 60_000, maxRetries: 0 },
            models: {
                providers: [
                    {
                        id: "stub",
                        name: "stub",
                        baseUrl: `http://127.0.0.1:${this.ports.stub}/v1`,
                        models: ["stub-1"],
                        defaultModel: "stub-1",
                        apiKeyEnv: null,
                    },
                ],
                activeProvider: "stub",
                activeModel: "stub-1",
                activeReasoning: "off",
            },
            network: { proxy: null },
            plugins: { update: { type: "npm", registry: "https://registry.npmjs.org", githubToken: null } },
            sandbox: {
                mode: "strict",
                backend: "auto",
                access: "read-only",
                maxConcurrent: 2,
                defaultTimeoutMs: 60_000,
                defaultMemoryMB: 512,
                outputLimitBytes: 16_777_216,
            },
        })
        writeJson(path.join(this.home, "config", "credentials.json"), {
            version: 2,
            openai: { apiKey: "sk-stub" },
            providers: { stub: "sk-stub" },
        })
        writeJson(path.join(this.home, "config", "plugins", "wellspring-gateway.json"), {
            host: "127.0.0.1",
            port: this.ports.gateway,
            auth: { enabled: false },
            accessLog: false,
        })
        writeJson(path.join(this.home, "config", "plugins", "wellspring-web.json"), {
            host: "127.0.0.1",
            port: this.ports.web,
            allowedHosts: ["127.0.0.1", "localhost"],
        })

        /* 工作区夹具；文件搜索、read 工具与 @ 引用用例共用 */
        await fsp.writeFile(path.join(this.workDir, "hello.txt"), "测试文件内容 hello\n第二行\n")
        await fsp.writeFile(
            path.join(this.workDir, "big.txt"),
            Array.from({ length: 200 }, (_, index) => `第 ${index + 1} 行 filler content`).join("\n"),
        )
        await fsp.mkdir(path.join(this.workDir, "docs"), { recursive: true })
        await fsp.writeFile(path.join(this.workDir, "docs", "note.md"), "# 测试文档\n\n这是文档内容。\n")
        await fsp.writeFile(path.join(this.workDir, "demo.js"), "export const answer = 42\n")

        await this.startStub()
        await this.startHost()
        await this.waitReady()
        this.backendReady = await this.detectBackend()
        return this
    }

    async startStub() {
        const logStream = fs.createWriteStream(this.logs.stubFile, { flags: "a" })
        this.stubLogStream = logStream
        const child = spawn(
            process.execPath,
            [STUB_SCRIPT, "--port", String(this.ports.stub)],
            { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
        )
        this.processes.stub = child
        const collect = (chunk) => {
            const text = chunk.toString()
            logStream.write(text)
            for (const line of text.split("\n")) {
                if (line.trim() !== "") {
                    this.logs.stub.push(line)
                }
            }
            if (this.logs.stub.length > 400) {
                this.logs.stub.splice(0, this.logs.stub.length - 400)
            }
        }
        child.stdout.on("data", collect)
        child.stderr.on("data", collect)
        child.on("exit", (code) => {
            this.logs.stub.push(`[stub 进程退出 code=${code}]`)
        })
        await waitFor(async () => {
            const result = await fetchJson(`http://127.0.0.1:${this.ports.stub}/__stub/health`, { timeoutMs: 1_500 })
            return result.status === 200 && result.json?.ok === true
        }, { timeoutMs: 15_000, label: "stub 模型就绪" })
    }

    async startHost() {
        const logStream = fs.createWriteStream(this.logs.hostFile, { flags: "a" })
        this.hostLogStream = logStream
        const child = spawn("wellspring", ["--home", this.home, "start"], {
            cwd: this.workDir,
            env: { ...process.env },
            stdio: ["ignore", "pipe", "pipe"],
        })
        this.processes.host = child
        const collect = (chunk) => {
            const text = chunk.toString()
            logStream.write(text)
            for (const line of text.split("\n")) {
                if (line.trim() !== "") {
                    this.logs.host.push(line)
                }
            }
            if (this.logs.host.length > 800) {
                this.logs.host.splice(0, this.logs.host.length - 800)
            }
        }
        child.stdout.on("data", collect)
        child.stderr.on("data", collect)
        child.on("exit", (code, signal) => {
            this.logs.host.push(`[宿主进程退出 code=${code} signal=${signal}]`)
        })
    }

    async waitReady() {
        try {
            await waitFor(async () => {
                if (this.processes.host === null || this.processes.host.exitCode !== null || this.processes.host.signalCode !== null) {
                    throw new Error("宿主进程已退出")
                }
                const result = await fetchJson(this.url("/__web/health"), { timeoutMs: 1_500 })
                if (result.status !== 200 || result.json?.status !== "ok") {
                    return false
                }
                this.health = result.json
                return true
            }, { timeoutMs: 90_000, intervalMs: 300, label: "插件直连健康检查" })
        } catch (error) {
            throw new Error(`${error instanceof Error ? error.message : String(error)}\n${this.tailHostLog(25)}`)
        }
        try {
            await waitFor(async () => {
                const result = await fetchJson(this.gatewayUrl("/web/__web/health"), { timeoutMs: 1_500 })
                return result.status === 200 && result.json?.status === "ok"
            }, { timeoutMs: 20_000, intervalMs: 250, label: "网关 /web 路由" })
            this.gatewayReady = true
        } catch {
            this.gatewayReady = false
        }
    }

    /** /api/bootstrap 是否可用（后端未就绪时返回 404） */
    async detectBackend() {
        try {
            const result = await fetchJson(this.url("/api/bootstrap"), { timeoutMs: 5_000 })
            if (result.status === 200 && result.json !== null && typeof result.json.version === "string") {
                this.backendReady = true
                return true
            }
            this.lastBootstrap = result
            return false
        } catch {
            return false
        }
    }

    async stopHost() {
        const child = this.processes.host
        this.processes.host = null
        if (child === null || child.exitCode !== null || child.signalCode !== null) {
            this.hostLogStream?.end()
            return
        }
        const exited = new Promise((resolve) => {
            child.once("exit", () => resolve(true))
            setTimeout(() => resolve(false), 15_000)
        })
        child.kill("SIGTERM")
        const ok = await exited
        if (!ok) {
            child.kill("SIGKILL")
            await new Promise((resolve) => setTimeout(resolve, 500))
        }
        this.hostLogStream?.end()
        this.hostLogStream = null
        /* 等端口释放，避免重启时 EADDRINUSE */
        await waitFor(async () => {
            try {
                const result = await fetchJson(this.url("/__web/health"), { timeoutMs: 800 })
                return result.status !== 200
            } catch {
                return true
            }
        }, { timeoutMs: 10_000, intervalMs: 200, label: "宿主端口释放" }).catch(() => {})
    }

    async restartHost() {
        await this.stopHost()
        this.health = null
        this.gatewayReady = false
        await this.startHost()
        await this.waitReady()
        this.backendReady = await this.detectBackend()
        this.logs.host.push("[harness] 宿主已重启")
    }

    async stopStub() {
        const child = this.processes.stub
        this.processes.stub = null
        if (child === null || child.exitCode !== null || child.signalCode !== null) {
            this.stubLogStream?.end()
            return
        }
        const exited = new Promise((resolve) => {
            child.once("exit", () => resolve(true))
            setTimeout(() => resolve(false), 5_000)
        })
        child.kill("SIGTERM")
        if (!(await exited)) {
            child.kill("SIGKILL")
        }
        this.stubLogStream?.end()
        this.stubLogStream = null
    }

    async stubStats() {
        const result = await fetchJson(`http://127.0.0.1:${this.ports.stub}/__stub/stats`, { timeoutMs: 3_000 })
        return result.json
    }

    async resetStubStats() {
        await fetchJson(`http://127.0.0.1:${this.ports.stub}/__stub/reset`, { timeoutMs: 3_000 })
    }

    tailHostLog(lines = 40) {
        return this.logs.host.slice(-lines).join("\n")
    }

    tailStubLog(lines = 20) {
        return this.logs.stub.slice(-lines).join("\n")
    }

    /** 插件数据目录（会话持久化文件所在） */
    pluginDataDir() {
        return path.join(this.home, "data", "plugin-data", "wellspring-web")
    }

    /** 停进程并（可选）删除临时 home */
    async cleanup({ success = true, keep = false } = {}) {
        await this.stopHost()
        await this.stopStub()
        if (!keep && success) {
            await fsp.rm(this.home, { recursive: true, force: true })
            return { removed: true, home: this.home }
        }
        return { removed: false, home: this.home }
    }
}

/* 直接运行时：起一套环境并保持，供手动调试浏览器 */
const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
    const harness = createHarness({})
    const shutdown = async () => {
        console.log("\n正在清理测试实例…")
        const result = await harness.cleanup({ success: !process.env.E2E_KEEP, keep: process.env.E2E_KEEP === "1" })
        console.log(result.removed ? "已删除临时 home" : `保留 home：${result.home}`)
        process.exit(0)
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
    harness
        .prepare()
        .then(() => {
            console.log(`home      ${harness.home}`)
            console.log(`直连      ${harness.webBase}/`)
            console.log(`网关      ${harness.gatewayBase}/web/`)
            console.log(`健康      ${harness.webBase}/__web/health`)
            console.log(`后端就绪  ${harness.backendReady ? "是" : "否"}`)
            console.log(`日志      ${harness.logs.hostFile}`)
            console.log("Ctrl+C 退出")
        })
        .catch((error) => {
            console.error("启动失败：", error)
            process.exit(1)
        })
}
