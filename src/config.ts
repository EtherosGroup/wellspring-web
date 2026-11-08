/*
 * 网页插件配置
 *
 * 配置文件：<configDir>/plugins/wellspring-web.json
 * 静态资源默认用插件目录自带的 www/，可用 wwwDir 覆盖为其它绝对路径
 */

import { PLUGIN_WWW_DIR } from "./assets.ts"
import { DEFAULT_CHAT_LIMITS, type ChatLimits } from "./chat-types.ts"

export interface WebConfig {
    readonly host: string
    readonly port: number
    /** 网关上的路径前缀 */
    readonly routePrefix: string
    /** 静态资源根目录（绝对路径），默认为插件目录的 www */
    readonly wwwDir: string
    /** 找不到文件时回退 index.html */
    readonly spaFallback: boolean
    /** 信任网关头时校验的 Host 主机名（DNS rebinding） */
    readonly allowedHosts: readonly string[]
    /** 会话与请求体限额 */
    readonly limits: ChatLimits
}

/** 默认只信任 loopback 主机名 */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]"]

export const DEFAULT_WEB_CONFIG: WebConfig = {
    host: "127.0.0.1",
    port: 8787,
    routePrefix: "/web",
    wwwDir: PLUGIN_WWW_DIR,
    spaFallback: true,
    allowedHosts: DEFAULT_ALLOWED_HOSTS,
    limits: DEFAULT_CHAT_LIMITS,
}

/** 宿主 HTTP 层的请求体上限 */
const HOST_MAX_BODY_BYTES = 16 * 1024 * 1024

export interface ParsedWebConfig {
    readonly config: WebConfig
    readonly warnings: readonly string[]
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizePrefix(value: string): string | null {
    const trimmed = value.trim()
    if (!trimmed.startsWith("/")) {
        return null
    }
    if (trimmed === "/") {
        return "/"
    }
    return trimmed.replace(/\/+$/, "")
}

export function normalizeHost(value: string): string | null {
    const trimmed = value.trim().toLowerCase()
    if (trimmed === "" || /[\s/\\?#@]/.test(trimmed)) {
        return null
    }
    const candidates =
        trimmed.includes(":") && !trimmed.startsWith("[") ? [trimmed, `[${trimmed}]`] : [trimmed]
    for (const candidate of candidates) {
        try {
            const hostname = new URL(`http://${candidate}`).hostname.toLowerCase().replace(/\.+$/, "")
            if (hostname !== "") {
                return hostname
            }
        } catch {
            /* 换一种写法再试 */
        }
    }
    return null
}

function parseAllowedHosts(value: unknown, warnings: string[]): readonly string[] {
    if (value === undefined) {
        return DEFAULT_ALLOWED_HOSTS
    }
    if (!Array.isArray(value)) {
        warnings.push("allowedHosts 不是数组")
        return DEFAULT_ALLOWED_HOSTS
    }
    const hosts: string[] = [...DEFAULT_ALLOWED_HOSTS]
    for (const [index, item] of value.entries()) {
        if (typeof item !== "string") {
            warnings.push(`allowedHosts[${index}] 不是字符串`)
            continue
        }
        const hostname = normalizeHost(item)
        if (hostname === null) {
            warnings.push(`allowedHosts[${index}] 不合法：${item}`)
            continue
        }
        if (!hosts.includes(hostname)) {
            hosts.push(hostname)
        }
    }
    return hosts
}

function isAbsolutePath(value: string): boolean {
    return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")
}

function normalizeWwwDir(value: string): string | null {
    const trimmed = value.trim()
    if (trimmed === "" || !isAbsolutePath(trimmed) || trimmed.includes("\0")) {
        return null
    }
    const normalized = trimmed.replace(/[\\/]+$/, "")
    return normalized === "" ? null : normalized
}

type LimitKey = keyof ChatLimits

const LIMIT_BOUNDS: Readonly<Record<LimitKey, readonly [number, number]>> = {
    maxMessageChars: [1, 1_000_000],
    maxReferences: [0, 1_000],
    maxBodyBytes: [1_024, HOST_MAX_BODY_BYTES],
    maxConversations: [1, 10_000],
    maxConversationChars: [1_000, 100_000_000],
    turnBufferChars: [1_024, 64 * 1024 * 1024],
}

function parseLimits(value: unknown, warnings: string[]): ChatLimits {
    if (value === undefined) {
        return DEFAULT_CHAT_LIMITS
    }
    if (!isObject(value)) {
        warnings.push("limits 不是对象")
        return DEFAULT_CHAT_LIMITS
    }
    const limits: Record<LimitKey, number> = { ...DEFAULT_CHAT_LIMITS }
    for (const key of Object.keys(LIMIT_BOUNDS) as LimitKey[]) {
        const raw = value[key]
        if (raw === undefined) {
            continue
        }
        const bounds = LIMIT_BOUNDS[key]
        if (typeof raw !== "number" || !Number.isInteger(raw) || raw < bounds[0] || raw > bounds[1]) {
            warnings.push(`limits.${key} 不合法：${String(raw)}`)
            continue
        }
        limits[key] = raw
    }
    return limits
}

export function parseWebConfig(raw: unknown): ParsedWebConfig {
    const defaults = DEFAULT_WEB_CONFIG
    if (raw !== undefined && !isObject(raw)) {
        return { config: defaults, warnings: ["插件配置不是对象"] }
    }
    const input = isObject(raw) ? raw : {}
    const warnings: string[] = []

    const rawHost = typeof input["host"] === "string" ? input["host"].trim() : ""
    const hostValid = rawHost !== "" && !/\s/.test(rawHost)
    if (input["host"] !== undefined && !hostValid) {
        warnings.push(`host 不合法：${String(input["host"])}`)
    }

    const port = input["port"]
    const portValid = typeof port === "number" && Number.isInteger(port) && port >= 0 && port <= 65_535
    if (port !== undefined && !portValid) {
        warnings.push(`port 不合法：${String(port)}`)
    }

    const rawPrefix = typeof input["routePrefix"] === "string" ? normalizePrefix(input["routePrefix"]) : null
    if (input["routePrefix"] !== undefined && rawPrefix === null) {
        warnings.push(`routePrefix 不合法：${String(input["routePrefix"])}`)
    }

    const rawWww = typeof input["wwwDir"] === "string" ? normalizeWwwDir(input["wwwDir"]) : null
    if (input["wwwDir"] !== undefined && rawWww === null) {
        warnings.push(`wwwDir 不是绝对路径：${String(input["wwwDir"])}`)
    }

    const spaFallback = input["spaFallback"]
    if (spaFallback !== undefined && typeof spaFallback !== "boolean") {
        warnings.push("spaFallback 不是布尔值")
    }

    return {
        config: {
            host: hostValid ? rawHost : defaults.host,
            port: portValid ? port : defaults.port,
            routePrefix: rawPrefix ?? defaults.routePrefix,
            wwwDir: rawWww ?? defaults.wwwDir,
            spaFallback: typeof spaFallback === "boolean" ? spaFallback : defaults.spaFallback,
            allowedHosts: parseAllowedHosts(input["allowedHosts"], warnings),
            limits: parseLimits(input["limits"], warnings),
        },
        warnings,
    }
}
