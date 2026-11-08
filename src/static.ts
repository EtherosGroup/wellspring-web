/*
 * 静态文件服务
 *
 * 根目录是插件自带的 www/（运行时 /plugin/www）；路径做归一化，隐藏文件与越界路径不对外
 * HTML 注入主题 cookie 与 <base href>（网关路径前缀），hashed assets 长缓存，其余资源短缓存
 */

import { posix } from "node:path"

import type { HttpRequest, HttpResponse } from "wellspring/api/host/index.ts"

import { applyThemeTemplate, MISSING_WWW_HTML, THEME_COOKIE } from "./assets.ts"
import { applySecurityHeaders, cookieValue, SECURITY_HEADERS } from "./security.ts"

export interface StaticFileStat {
    readonly type: "file" | "directory" | "other"
    readonly size: number
    readonly mtimeMs: number
}

export interface StaticFileSystem {
    stat(path: string): Promise<StaticFileStat | null>
    readBytes(path: string): Promise<Uint8Array | null>
}

export interface StaticOptions {
    /** 静态资源根目录（绝对路径） */
    readonly root: string
    /** 找不到文件时回退 index.html */
    readonly spaFallback: boolean
}

const MIME_TYPES: Readonly<Record<string, string>> = {
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    js: "application/javascript",
    mjs: "application/javascript",
    json: "application/json",
    map: "application/json",
    txt: "text/plain",
    xml: "application/xml",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    wasm: "application/wasm",
    webmanifest: "application/manifest+json",
}

const TEXTUAL_TYPES: ReadonlySet<string> = new Set([
    "text/html",
    "text/css",
    "text/plain",
    "text/xml",
    "application/javascript",
    "application/json",
    "application/xml",
    "application/manifest+json",
    "image/svg+xml",
])

/** hashed 资源：assets/ 下带 8 位以上 hash 后缀的文件名 */
const HASHED_ASSET = /^assets\/.*-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/

/** index.html 模板缓存；按 fs 实例隔离，测试互不污染 */
const htmlTemplates = new WeakMap<StaticFileSystem, Map<string, { signature: string; template: string }>>()

function trimRoot(root: string): string {
    return root.replace(/[\\/]+$/, "")
}

function extensionOf(path: string): string {
    const name = path.slice(path.lastIndexOf("/") + 1)
    const index = name.lastIndexOf(".")
    return index <= 0 ? "" : name.slice(index + 1).toLowerCase()
}

function mimeOf(path: string): string {
    return MIME_TYPES[extensionOf(path)] ?? "application/octet-stream"
}

function isTextual(mime: string): boolean {
    return TEXTUAL_TYPES.has(mime)
}

function cacheControlFor(rel: string, mime: string): string {
    if (mime === "text/html") {
        return "no-store"
    }
    return HASHED_ASSET.test(rel) ? "public, max-age=31536000, immutable" : "public, max-age=300"
}

function textResponse(status: number, text: string, headers: Record<string, string> = {}): HttpResponse {
    return applySecurityHeaders({
        status,
        headers: {
            "content-type": "text/plain; charset=utf-8",
            "content-length": String(Buffer.byteLength(text)),
            "cache-control": "no-store",
            ...headers,
        },
        body: text,
    })
}

function htmlResponse(status: number, html: string): HttpResponse {
    return applySecurityHeaders(
        {
            status,
            headers: {
                "content-type": "text/html; charset=utf-8",
                "content-length": String(Buffer.byteLength(html)),
                "cache-control": "no-store",
                vary: "cookie",
                ...SECURITY_HEADERS,
            },
            body: html,
        },
        { html: true },
    )
}

/** 前端产物缺失时的提示页 */
function missingWwwResponse(): HttpResponse {
    return htmlResponse(503, MISSING_WWW_HTML)
}

/** 网关注入的路径前缀允许的字符；不含百分号编码与反斜杠 */
const FORWARDED_PREFIX = /^\/[A-Za-z0-9._~/-]*$/
const MAX_PREFIX_CHARS = 256
const BASE_TAG = /<base\b[^>]*>/i
const BASE_HEAD = /<head\b[^>]*>/i

/**
 * 请求对应的页面 base 路径
 *
 * 网关 proxy 带 x-forwarded-prefix（如 /web）；直连端口没有该头，base 为 /
 * 前缀按字面校验，去掉 . 与 .. 段后补尾斜杠
 */
export function baseHrefOf(request: HttpRequest): string {
    const raw = (request.headers["x-forwarded-prefix"] ?? "").split(",")[0]?.trim() ?? ""
    if (raw === "" || raw.length > MAX_PREFIX_CHARS || !FORWARDED_PREFIX.test(raw)) {
        return "/"
    }
    const segments = raw.split("/").filter((segment) => segment !== "" && segment !== "." && segment !== "..")
    return segments.length === 0 ? "/" : `/${segments.join("/")}/`
}

/**
 * 把 index.html 的 <base href> 换成本次请求的 base
 *
 * 模板带 <base href="./" /> 占位时替换属性值，不追加第二个标签
 * 模板没有 base 时在 <head> 后补一个（旧构建产物）
 */
export function injectBaseHref(html: string, base: string): string {
    const tag = BASE_TAG.exec(html)
    if (tag !== null) {
        const original = tag[0]
        let replaced = original.replace(/\bhref\s*=\s*"[^"]*"/i, `href="${base}"`)
        if (replaced === original) {
            replaced = original.replace(/^<base\b/i, `<base href="${base}"`)
        }
        return html.slice(0, tag.index) + replaced + html.slice(tag.index + original.length)
    }
    const head = BASE_HEAD.exec(html)
    if (head === null) {
        return html
    }
    const index = head.index + head[0].length
    return `${html.slice(0, index)}\n<base href="${base}" />${html.slice(index)}`
}

function acceptsHtml(request: HttpRequest): boolean {
    const accept = request.headers["accept"] ?? ""
    return accept.includes("text/html") || accept.includes("*/*")
}

/** URL 路径 → www 内相对路径；返回 null 表示路径非法 */
function relativePathOf(pathname: string): string | null {
    let decoded: string
    try {
        decoded = decodeURIComponent(pathname)
    } catch {
        return null
    }
    if (decoded.includes("\0") || decoded.includes("\\")) {
        return null
    }
    const normalized = posix.normalize(decoded)
    if (!normalized.startsWith("/")) {
        return null
    }
    return normalized.replace(/^\/+/, "")
}

function isHidden(rel: string): boolean {
    return rel.split("/").some((segment) => segment.startsWith("."))
}

interface ResolvedFile {
    readonly file: string
    readonly rel: string
    readonly stat: StaticFileStat
}

interface ResolvedRedirect {
    readonly location: string
}

async function resolveTarget(
    fs: StaticFileSystem,
    root: string,
    rel: string,
    request: HttpRequest,
): Promise<ResolvedFile | ResolvedRedirect | null> {
    const clean = rel === "" ? "" : rel.replace(/\/+$/, "")
    const path = clean === "" ? root : `${root}/${clean}`
    const stat = await fs.stat(path)
    if (stat === null) {
        return null
    }
    if (stat.type === "file") {
        return { file: path, rel: clean, stat }
    }
    if (stat.type !== "directory") {
        return null
    }
    if (clean !== "" && !rel.endsWith("/")) {
        const url = new URL(request.url, "http://localhost")
        return { location: `${url.pathname}/${url.search}` }
    }
    const indexPath = clean === "" ? `${root}/index.html` : `${path}/index.html`
    const indexStat = await fs.stat(indexPath)
    return indexStat !== null && indexStat.type === "file"
        ? { file: indexPath, rel: `${clean === "" ? "" : `${clean}/`}index.html`, stat: indexStat }
        : null
}

/** index.html 模板：按文件 stat 签名缓存，{{theme}} 每次请求替换 */
function templateOf(fs: StaticFileSystem, file: string, stat: StaticFileStat, bytes: Uint8Array): string {
    let cache = htmlTemplates.get(fs)
    if (cache === undefined) {
        cache = new Map()
        htmlTemplates.set(fs, cache)
    }
    const signature = `${stat.size}:${Math.floor(stat.mtimeMs)}`
    const cached = cache.get(file)
    if (cached !== undefined && cached.signature === signature) {
        return cached.template
    }
    const template = Buffer.from(bytes).toString("utf8")
    cache.set(file, { signature, template })
    return template
}

function themeOf(request: HttpRequest): string {
    return cookieValue(request, THEME_COOKIE) ?? ""
}

async function sendFile(
    fs: StaticFileSystem,
    file: ResolvedFile,
    request: HttpRequest,
    headOnly: boolean,
): Promise<HttpResponse> {
    const bytes = await fs.readBytes(file.file)
    if (bytes === null) {
        return textResponse(404, "未找到")
    }
    const mime = mimeOf(file.file)
    if (mime === "text/html") {
        const template = templateOf(fs, file.file, file.stat, bytes)
        const html = injectBaseHref(
            applyThemeTemplate(template, themeOf(request)),
            baseHrefOf(request),
        )
        const response = htmlResponse(200, html)
        return headOnly ? { ...response, body: "" } : response
    }
    const etag = `W/"${file.stat.size}-${Math.floor(file.stat.mtimeMs)}"`
    const cacheControl = cacheControlFor(file.rel, mime)
    const ifNoneMatch = request.headers["if-none-match"]
    if (typeof ifNoneMatch === "string") {
        const candidates = ifNoneMatch.split(",").map((value) => value.trim())
        if (candidates.includes(etag)) {
            return applySecurityHeaders({
                status: 304,
                headers: { etag, "cache-control": cacheControl },
                body: "",
            })
        }
    }
    const textual = isTextual(mime)
    const headers: Record<string, string> = {
        "content-type": textual ? `${mime}; charset=utf-8` : mime,
        "content-length": String(bytes.length),
        "cache-control": cacheControl,
        etag,
    }
    if (headOnly) {
        return applySecurityHeaders({ status: 200, headers, body: "" })
    }
    const body = textual ? Buffer.from(bytes).toString("utf8") : Buffer.from(bytes).toString("base64")
    return applySecurityHeaders({
        status: 200,
        headers,
        body,
        ...(textual ? {} : { bodyEncoding: "base64" as const }),
    })
}

export async function serveStatic(
    request: HttpRequest,
    fs: StaticFileSystem,
    options: StaticOptions,
): Promise<HttpResponse> {
    const method = (request.method === "" ? "GET" : request.method).toUpperCase()
    if (method !== "GET" && method !== "HEAD") {
        return textResponse(405, "不支持的请求方法", { allow: "GET, HEAD" })
    }
    let url: URL
    try {
        url = new URL(request.url, "http://localhost")
    } catch {
        return textResponse(400, "请求地址不合法")
    }
    const rel = relativePathOf(url.pathname)
    if (rel === null) {
        return textResponse(400, "路径不合法")
    }
    if (isHidden(rel)) {
        return textResponse(404, "未找到")
    }
    const root = trimRoot(options.root)
    const headOnly = method === "HEAD"
    const isRootPath = rel === "" || rel === "index.html"
    const target = await resolveTarget(fs, root, rel, request)
    if (target !== null) {
        if ("location" in target) {
            return applySecurityHeaders({
                status: 301,
                headers: { location: target.location, "cache-control": "no-store" },
                body: "",
            })
        }
        return await sendFile(fs, target, request, headOnly)
    }
    if (options.spaFallback && acceptsHtml(request) && method === "GET") {
        const index = await resolveTarget(fs, root, "index.html", request)
        if (index !== null && !("location" in index)) {
            return await sendFile(fs, index, request, false)
        }
        return missingWwwResponse()
    }
    if (isRootPath) {
        return missingWwwResponse()
    }
    return textResponse(404, "未找到")
}
