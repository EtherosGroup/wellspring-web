/*
 * 静态文件服务
 *
 * 根目录是插件数据目录内的 www/；路径做归一化，隐藏文件与越界路径不对外
 */

import { posix } from "node:path"

import type { HttpRequest, HttpResponse } from "wellspring/api/host/index.ts"

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
    /** 插件数据目录内的资源目录，例如 www */
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

const TEXTUAL_TYPES = new Set([
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

function textResponse(status: number, body: string, headers: Record<string, string> = {}): HttpResponse {
    return {
        status,
        headers: {
            "content-type": "text/plain; charset=utf-8",
            "content-length": String(Buffer.byteLength(body)),
            "cache-control": "no-store",
            ...headers,
        },
        body,
    }
}

function extensionOf(path: string): string {
    const name = path.slice(path.lastIndexOf("/") + 1)
    const index = name.lastIndexOf(".")
    return index <= 0 ? "" : name.slice(index + 1).toLowerCase()
}

function mimeOf(path: string): string {
    return MIME_TYPES[extensionOf(path)] ?? "application/octet-stream"
}

function cacheControlFor(path: string): string {
    return extensionOf(path) === "html" ? "no-cache" : "public, max-age=300"
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
        return { file: path, stat }
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
    return indexStat !== null && indexStat.type === "file" ? { file: indexPath, stat: indexStat } : null
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
    const etag = `W/"${file.stat.size}-${Math.floor(file.stat.mtimeMs)}"`
    const ifNoneMatch = request.headers["if-none-match"]
    if (typeof ifNoneMatch === "string") {
        const candidates = ifNoneMatch.split(",").map((value) => value.trim())
        if (candidates.includes(etag)) {
            return {
                status: 304,
                headers: { etag, "cache-control": cacheControlFor(file.file) },
                body: "",
            }
        }
    }
    const mime = mimeOf(file.file)
    const textual = TEXTUAL_TYPES.has(mime)
    const headers: Record<string, string> = {
        "content-type": textual ? `${mime}; charset=utf-8` : mime,
        "content-length": String(bytes.length),
        "cache-control": cacheControlFor(file.file),
        etag,
        "x-content-type-options": "nosniff",
    }
    if (headOnly) {
        return { status: 200, headers, body: "" }
    }
    const body = textual ? Buffer.from(bytes).toString("utf8") : Buffer.from(bytes).toString("base64")
    return {
        status: 200,
        headers,
        body,
        ...(textual ? {} : { bodyEncoding: "base64" as const }),
    }
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
    const headOnly = method === "HEAD"
    const target = await resolveTarget(fs, options.root, rel, request)
    if (target !== null) {
        if ("location" in target) {
            return { status: 301, headers: { location: target.location, "cache-control": "no-store" }, body: "" }
        }
        return await sendFile(fs, target, request, headOnly)
    }
    if (options.spaFallback && acceptsHtml(request) && method === "GET") {
        const index = await resolveTarget(fs, options.root, "index.html", request)
        if (index !== null && !("location" in index)) {
            return await sendFile(fs, index, request, false)
        }
    }
    return textResponse(404, "未找到")
}
