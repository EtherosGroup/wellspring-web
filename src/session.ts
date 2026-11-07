/*
 * 会话校验
 *
 * 经网关代理的请求信任网关注入的 x-wellspring-* 头：网关已完成鉴权或在 public 路由放行
 * 直连插件端口的请求没有这些头，用网关会话 cookie 校验，未登录跳网关登录页
 */

import type { HttpRequest, HttpResponse } from "wellspring/api/host/index.ts"

import { DEFAULT_ALLOWED_HOSTS, normalizeHost } from "./config.ts"
import { acceptsHtml, sha256Hex, type SsoClient, type SsoFailureReason } from "./sso-client.ts"

const GATEWAY_MARKER_HEADER = "x-wellspring-gateway"
const USER_HEADER = "x-wellspring-user"
const REDIRECT_MEMORY_MS = 5 * 60 * 1000
const REDIRECT_MEMORY_LIMIT = 256

export type SessionFailureReason = SsoFailureReason | "untrusted-host" | "unavailable" | "loop"

export type SessionDecision =
    | { readonly ok: true; readonly user: string | null }
    | { readonly ok: false; readonly reason: SessionFailureReason; readonly response: HttpResponse }

export interface SessionOptions {
    /** 信任网关头时允许的 Host 主机名 */
    readonly allowedHosts?: readonly string[]
    /** sso 缺失时拒绝直连请求（发现文件损坏、客户端初始化失败） */
    readonly failClosed?: boolean
}

function headerValue(headers: Record<string, string>, name: string): string | null {
    const direct = headers[name]
    if (direct !== undefined) {
        return direct
    }
    const lowered = name.toLowerCase()
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === lowered) {
            return value
        }
    }
    return null
}

function hostNameOf(headers: Record<string, string>): string | null {
    const host = headerValue(headers, "host")
    return host === null ? null : normalizeHost(host)
}

function textResponse(
    status: number,
    body: string,
    headers: Record<string, string> = {},
): HttpResponse {
    return {
        status,
        headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            ...headers,
        },
        body,
    }
}

/* 浏览器当前地址（host[:port] + path），作为网关的 redirect 参数 */
export function redirectTargetOf(request: HttpRequest): string | null {
    const host = headerValue(request.headers, "host")
    if (host === null || host.trim() === "" || /[\u0000-\u0020\u007f]/.test(host)) {
        return null
    }
    const url = request.url === "" ? "/" : request.url
    return `${host.trim()}${url.startsWith("/") ? url : `/${url}`}`
}

/*
 * 网关登录地址：仅当请求 Host 在 allowedHosts 内时替换登录地址主机名（支持局域网 IP）
 * 不可信 Host（如 DNS rebinding 域名）回退网关地址，会话 cookie 不落到外部域名
 */
export function loginLocationOf(
    request: HttpRequest,
    sso: SsoClient,
    allowedHosts: readonly string[] = DEFAULT_ALLOWED_HOSTS,
): string {
    const loginUrl = new URL(sso.loginUrl())
    const hostname = hostNameOf(request.headers)
    const trusted = hostname !== null && allowedHosts.includes(hostname)
    const base = trusted
        ? `${loginUrl.protocol}//${hostname}${loginUrl.port === "" ? "" : `:${loginUrl.port}`}`
        : loginUrl.origin
    const target = trusted ? redirectTargetOf(request) : null
    if (target === null) {
        return `${base}${loginUrl.pathname}`
    }
    return `${base}${loginUrl.pathname}?redirect=${encodeURIComponent(target)}`
}

function loginResponse(
    request: HttpRequest,
    sso: SsoClient,
    allowedHosts: readonly string[],
): HttpResponse {
    /* 插件端口是 http；https 网关下 Secure cookie 不会发给直连端口，跳转会形成循环 */
    if (new URL(sso.loginUrl()).protocol !== "http:") {
        return textResponse(503, "直连端口需与网关同协议")
    }
    return {
        status: 302,
        headers: { location: loginLocationOf(request, sso, allowedHosts), "cache-control": "no-store" },
        body: "",
    }
}

/*
 * 快照滞后时直连校验失败会跳网关、网关再回跳直连，形成重定向循环
 * 同一 token 短时间重复校验失败按 503 终止；校验通过后清除记录
 */
const recentRedirects = new Map<string, number>()

function pruneRedirects(now: number): void {
    for (const [fingerprint, until] of recentRedirects) {
        if (until <= now) {
            recentRedirects.delete(fingerprint)
        }
    }
}

function isRecentRedirect(token: string, now: number): boolean {
    pruneRedirects(now)
    const until = recentRedirects.get(sha256Hex(token))
    return until !== undefined && until > now
}

function rememberRedirect(token: string, now: number): void {
    if (recentRedirects.size >= REDIRECT_MEMORY_LIMIT) {
        pruneRedirects(now)
        while (recentRedirects.size >= REDIRECT_MEMORY_LIMIT) {
            const oldest = recentRedirects.keys().next()
            if (oldest.done === true) {
                break
            }
            recentRedirects.delete(oldest.value)
        }
    }
    recentRedirects.set(sha256Hex(token), now + REDIRECT_MEMORY_MS)
}

function forgetRedirect(token: string): void {
    recentRedirects.delete(sha256Hex(token))
}

type GatewayOrigin =
    | { readonly kind: "user"; readonly user: string | null }
    | { readonly kind: "rejected"; readonly response: HttpResponse }

/** 网关代理请求的 Host 是否在允许列表内 */
export function gatewayHostTrusted(
    request: HttpRequest,
    allowedHosts: readonly string[] = DEFAULT_ALLOWED_HOSTS,
): boolean {
    const hostname = hostNameOf(request.headers)
    return hostname !== null && allowedHosts.includes(hostname)
}

/* 网关代理请求：marker 头存在时校验 Host 白名单（DNS rebinding） */
function gatewayOrigin(
    request: HttpRequest,
    allowedHosts: readonly string[],
): GatewayOrigin | undefined {
    if (headerValue(request.headers, GATEWAY_MARKER_HEADER) !== "1") {
        return undefined
    }
    const hostname = hostNameOf(request.headers)
    if (hostname === null || !allowedHosts.includes(hostname)) {
        return { kind: "rejected", response: textResponse(403, "Host 不受信任") }
    }
    return { kind: "user", user: headerValue(request.headers, USER_HEADER) ?? null }
}

/* 网关代理请求直接放行；直连请求校验网关会话，sso 缺失时按 failClosed 决定是否放行 */
export async function checkSession(
    request: HttpRequest,
    sso: SsoClient | null,
    options: SessionOptions = {},
): Promise<SessionDecision> {
    const allowedHosts = options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS
    const gateway = gatewayOrigin(request, allowedHosts)
    if (gateway !== undefined) {
        if (gateway.kind === "rejected") {
            return { ok: false, reason: "untrusted-host", response: gateway.response }
        }
        return { ok: true, user: gateway.user }
    }
    if (sso === null) {
        if (options.failClosed === true) {
            return { ok: false, reason: "unavailable", response: textResponse(503, "会话校验不可用") }
        }
        return { ok: true, user: null }
    }
    const result = await sso.verify(request.headers)
    const token = sso.sessionToken(request.headers)
    if (result.ok) {
        if (token !== null) {
            forgetRedirect(token)
        }
        return { ok: true, user: result.user }
    }
    if (result.reason === "unreachable") {
        return { ok: false, reason: result.reason, response: textResponse(503, "会话校验不可用") }
    }
    /* 非页面请求不走登录跳转，不存在回跳循环 */
    if (!acceptsHtml(request.headers)) {
        return { ok: false, reason: result.reason, response: sso.unauthorized() }
    }
    if (token !== null) {
        const now = Date.now()
        if (isRecentRedirect(token, now)) {
            return { ok: false, reason: "loop", response: textResponse(503, "会话状态不同步") }
        }
        rememberRedirect(token, now)
    }
    return {
        ok: false,
        reason: result.reason,
        response: loginResponse(request, sso, allowedHosts),
    }
}
