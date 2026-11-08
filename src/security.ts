/*
 * 请求校验、响应辅助与安全头
 *
 * 写请求要求 x-web-request: 1（跨站写请求会触发预检）、有请求体时 application/json、
 * 有 Origin 时其 host 必须等于 Host。请求体是 HttpRequest.body 里的 base64，上限默认 1MiB
 * 规范见 docs/ARCHITECTURE.md 第 7 节
 */

import type { HttpRequest, HttpResponse } from "wellspring/api/host/index.ts"

/**
 * 写请求必须携带的请求头
 *
 * 不能以 x-wellspring- 开头：网关代理会丢弃客户端传入的 x-wellspring-* 头
 */
export const WEB_REQUEST_HEADER = "x-web-request"

/** 会话校验注入的用户头（index.ts 已做来源信任校验） */
export const USER_HEADER = "x-wellspring-user"

/** SSE 心跳间隔 */
export const SSE_PING_MS = 15_000

/** SSE 注释行心跳 */
export const SSE_PING_CHUNK = ": ping\n\n"

/** 所有响应的安全头 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
}

/*
 * HTML 的 CSP
 *
 * 前端不写内联脚本，内联 style 属性仅用于动态尺寸
 * base-uri 'self'：index.html 注入 <base href>（网关路径前缀），'none' 会拦掉 base 元素
 */
export const CONTENT_SECURITY_POLICY =
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'"

const WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"])

export function isWriteMethod(method: string): boolean {
    return WRITE_METHODS.has(method.toUpperCase())
}

/** 合并安全头；HTML 额外带 CSP */
export function applySecurityHeaders(
    response: HttpResponse,
    options: { readonly html?: boolean } = {},
): HttpResponse {
    const headers: Record<string, string> = { ...response.headers, ...SECURITY_HEADERS }
    if (options.html === true) {
        headers["content-security-policy"] = CONTENT_SECURITY_POLICY
    }
    return { ...response, headers }
}

function withBodyHeaders(
    headers: Record<string, string>,
    contentType: string,
    body: string,
): Record<string, string> {
    return {
        "content-type": contentType,
        "content-length": String(Buffer.byteLength(body)),
        "cache-control": "no-store",
        ...SECURITY_HEADERS,
        ...headers,
    }
}

/** JSON 响应；默认 no-store */
export function jsonResponse(
    status: number,
    value: unknown,
    headers: Record<string, string> = {},
): HttpResponse {
    const body = JSON.stringify(value)
    return {
        status,
        headers: withBodyHeaders(headers, "application/json; charset=utf-8", body),
        body,
    }
}

/** 纯文本响应 */
export function textResponse(
    status: number,
    text: string,
    headers: Record<string, string> = {},
): HttpResponse {
    const body = text
    return {
        status,
        headers: withBodyHeaders(headers, "text/plain; charset=utf-8", body),
        body,
    }
}

/** 错误响应：{ error, code? } */
export function errorResponse(
    status: number,
    error: string,
    code?: string,
    headers: Record<string, string> = {},
): HttpResponse {
    return jsonResponse(status, code === undefined ? { error } : { error, code }, headers)
}

/** SSE 响应头；流式 handler 返回前写入的 chunk 由宿主缓冲后按序下发 */
export function sseResponse(headers: Record<string, string> = {}): HttpResponse {
    return {
        status: 200,
        headers: {
            ...SECURITY_HEADERS,
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
            connection: "keep-alive",
            "x-accel-buffering": "no",
            ...headers,
        },
        stream: true,
    }
}

/** 单个 SSE 数据事件：一行 data + 空行 */
export function sseChunk(payload: unknown): string {
    return `data: ${JSON.stringify(payload)}\n\n`
}

/** cookie 头解析；同名取第一个 */
export function parseCookies(header: string | undefined): Record<string, string> {
    const cookies: Record<string, string> = {}
    if (header === undefined || header === "") {
        return cookies
    }
    for (const part of header.split(";")) {
        const index = part.indexOf("=")
        if (index <= 0) {
            continue
        }
        const name = part.slice(0, index).trim()
        if (name === "" || cookies[name] !== undefined) {
            continue
        }
        let value = part.slice(index + 1).trim()
        if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1)
        }
        try {
            cookies[name] = decodeURIComponent(value)
        } catch {
            cookies[name] = value
        }
    }
    return cookies
}

/** 请求 cookie 中的值 */
export function cookieValue(request: HttpRequest, name: string): string | undefined {
    return parseCookies(request.headers["cookie"])[name]
}

/** 已校验来源的网关用户；直连端口由 index.ts 注入同一个头 */
export function requestUser(request: HttpRequest): string | null {
    const user = request.headers[USER_HEADER]?.trim() ?? ""
    return user === "" ? null : user
}

/** base64 请求体 → 字节 */
export function readBodyBytes(request: HttpRequest): Uint8Array {
    if (request.body === "") {
        return new Uint8Array(0)
    }
    return new Uint8Array(Buffer.from(request.body, "base64"))
}

/** 请求体大小估计：content-length 与实际 base64 长度的较大者 */
export function estimateBodyBytes(request: HttpRequest): number {
    const declared = Number(request.headers["content-length"] ?? Number.NaN)
    const fromBase64 = request.body === "" ? 0 : Math.floor((request.body.length * 3) / 4)
    return Number.isFinite(declared) && declared > fromBase64 ? declared : fromBase64
}

function sameOrigin(request: HttpRequest): boolean {
    const origin = request.headers["origin"]
    if (origin === undefined || origin === "") {
        return true
    }
    let parsed: URL
    try {
        parsed = new URL(origin)
    } catch {
        return false
    }
    const host = request.headers["host"]?.trim().toLowerCase() ?? ""
    return host !== "" && parsed.host.toLowerCase() === host
}

function isJsonContentType(value: string | undefined): boolean {
    if (value === undefined) {
        return false
    }
    return value.split(";")[0]?.trim().toLowerCase() === "application/json"
}

/**
 * 写请求校验：CSRF 头、同源 Origin、体积、JSON content-type
 *
 * 返回 null 表示通过
 */
export function guardWrite(request: HttpRequest, maxBodyBytes: number): HttpResponse | null {
    if (!isWriteMethod(request.method)) {
        return null
    }
    if (request.headers[WEB_REQUEST_HEADER] !== "1") {
        return errorResponse(403, `缺少 ${WEB_REQUEST_HEADER} 请求头`, "csrf")
    }
    if (!sameOrigin(request)) {
        return errorResponse(403, "跨站请求来源不匹配", "cross-origin")
    }
    if (estimateBodyBytes(request) > maxBodyBytes) {
        return errorResponse(413, "请求体过大", "body-too-large")
    }
    if (request.body !== "" && !isJsonContentType(request.headers["content-type"])) {
        return errorResponse(415, "请求体必须是 application/json", "unsupported-media-type")
    }
    return null
}

export interface JsonBodyResult {
    readonly ok: boolean
    readonly value?: Record<string, unknown>
    readonly response?: HttpResponse
}

/** 读取 JSON 对象请求体；空体视为 {} */
export function readJsonObject(request: HttpRequest, maxBodyBytes: number): JsonBodyResult {
    if (estimateBodyBytes(request) > maxBodyBytes) {
        return { ok: false, response: errorResponse(413, "请求体过大", "body-too-large") }
    }
    if (request.body === "") {
        return { ok: true, value: {} }
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(Buffer.from(request.body, "base64").toString("utf8"))
    } catch {
        return { ok: false, response: errorResponse(400, "请求体不是合法 JSON", "invalid-json") }
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, response: errorResponse(400, "请求体不是 JSON 对象", "invalid-json") }
    }
    return { ok: true, value: parsed as Record<string, unknown> }
}
