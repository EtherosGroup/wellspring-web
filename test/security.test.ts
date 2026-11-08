import assert from "node:assert/strict"
import { test } from "node:test"

import type { HttpRequest, HttpResponse } from "wellspring/api/host/index.ts"

import {
    applySecurityHeaders,
    CONTENT_SECURITY_POLICY,
    cookieValue,
    errorResponse,
    estimateBodyBytes,
    guardWrite,
    jsonResponse,
    parseCookies,
    readBodyBytes,
    readJsonObject,
    requestUser,
    SECURITY_HEADERS,
    sseChunk,
    sseResponse,
    SSE_PING_CHUNK,
    WEB_REQUEST_HEADER,
} from "../src/security.ts"

const MAX_BODY = 1024

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
    return {
        method: "GET",
        url: "/api/bootstrap",
        headers: {},
        body: "",
        remoteAddress: null,
        ...overrides,
    }
}

function payloadOf(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString("base64")
}

function writeRequest(body: unknown, headers: Record<string, string> = {}): HttpRequest {
    return request({
        method: "POST",
        headers: {
            host: "127.0.0.1:8787",
            [WEB_REQUEST_HEADER]: "1",
            "content-type": "application/json",
            ...headers,
        },
        body: payloadOf(body),
    })
}

test("cookie 解析：多值、引号、重复取第一个、非法编码保留原文", () => {
    assert.deepEqual(parseCookies(undefined), {})
    assert.deepEqual(parseCookies("a=1; b=2"), { a: "1", b: "2" })
    assert.deepEqual(parseCookies('wellspring_web_theme="dark"; x=y'), {
        wellspring_web_theme: "dark",
        x: "y",
    })
    assert.deepEqual(parseCookies("a=1; a=2"), { a: "1" })
    assert.deepEqual(parseCookies("broken; =x; c=ok"), { c: "ok" })
    assert.deepEqual(parseCookies("t=light"), { t: "light" })
    const encoded = parseCookies("name=%E4%BD%A0%E5%A5%BD")
    assert.equal(encoded["name"], "你好")
    assert.equal(parseCookies("bad=%E0%A4%A")["bad"], "%E0%A4%A")
})

test("cookie 取值与用户头", () => {
    const req = request({ headers: { cookie: "wellspring_web_theme=dark", "x-wellspring-user": " alice " } })
    assert.equal(cookieValue(req, "wellspring_web_theme"), "dark")
    assert.equal(cookieValue(req, "missing"), undefined)
    assert.equal(requestUser(req), "alice")
    assert.equal(requestUser(request()), null)
    assert.equal(requestUser(request({ headers: { "x-wellspring-user": "  " } })), null)
})

test("请求体：base64 解码与体积估计", () => {
    const req = request({ body: Buffer.from("hello").toString("base64") })
    assert.equal(Buffer.from(readBodyBytes(req)).toString("utf8"), "hello")
    assert.deepEqual([...readBodyBytes(request())], [])
    assert.ok(estimateBodyBytes(req) >= 5)
    const declared = request({ headers: { "content-length": "999" } })
    assert.equal(estimateBodyBytes(declared), 999)
})

test("guardWrite：非写请求直接通过", () => {
    assert.equal(guardWrite(request({ method: "GET" }), MAX_BODY), null)
    assert.equal(guardWrite(request({ method: "HEAD" }), MAX_BODY), null)
})

test("guardWrite：写请求缺少 x-web-request 头返回 403", () => {
    const response = guardWrite(request({ method: "POST", body: "" }), MAX_BODY)
    assert.equal(response?.status, 403)
    assert.match(String(response?.body), /x-web-request/)
})

test("guardWrite：空体写请求不需要 content-type", () => {
    const req = request({ method: "POST", headers: { [WEB_REQUEST_HEADER]: "1" } })
    assert.equal(guardWrite(req, MAX_BODY), null)
})

test("guardWrite：JSON 请求体通过，非 JSON 返回 415", () => {
    assert.equal(guardWrite(writeRequest({ message: "hi" }), MAX_BODY), null)
    const jsonCharset = writeRequest({ message: "hi" }, { "content-type": "application/json; charset=utf-8" })
    assert.equal(guardWrite(jsonCharset, MAX_BODY), null)
    const text = writeRequest({ message: "hi" }, { "content-type": "text/plain" })
    assert.equal(guardWrite(text, MAX_BODY)?.status, 415)
    const missing = writeRequest({ message: "hi" }, { "content-type": "" })
    assert.equal(guardWrite(missing, MAX_BODY)?.status, 415)
})

test("guardWrite：Origin 与 Host 不同源返回 403", () => {
    const ok = writeRequest({}, { origin: "http://127.0.0.1:8787" })
    assert.equal(guardWrite(ok, MAX_BODY), null)
    const upper = writeRequest({}, { origin: "http://LOCALHOST:8787", host: "localhost:8787" })
    assert.equal(guardWrite(upper, MAX_BODY), null)
    const cross = writeRequest({}, { origin: "http://evil.example" })
    assert.equal(guardWrite(cross, MAX_BODY)?.status, 403)
    const nullOrigin = writeRequest({}, { origin: "null" })
    assert.equal(guardWrite(nullOrigin, MAX_BODY)?.status, 403)
    const noHost = request({
        method: "POST",
        headers: { [WEB_REQUEST_HEADER]: "1", origin: "http://127.0.0.1:8787" },
    })
    assert.equal(guardWrite(noHost, MAX_BODY)?.status, 403)
})

test("guardWrite：超过体积上限返回 413", () => {
    const declared = request({
        method: "POST",
        headers: { [WEB_REQUEST_HEADER]: "1", "content-length": "2048" },
        body: "",
    })
    assert.equal(guardWrite(declared, MAX_BODY)?.status, 413)
    const big = request({
        method: "POST",
        headers: { [WEB_REQUEST_HEADER]: "1", "content-type": "application/json" },
        body: "x".repeat(Math.ceil((MAX_BODY * 4) / 3) + 8),
    })
    assert.equal(guardWrite(big, MAX_BODY)?.status, 413)
})

test("readJsonObject：空体、对象、非法 JSON、非对象、超限", () => {
    const empty = readJsonObject(request({ method: "POST" }), MAX_BODY)
    assert.equal(empty.ok, true)
    assert.deepEqual(empty.value, {})

    const value = readJsonObject(writeRequest({ a: 1, b: "x" }), MAX_BODY)
    assert.equal(value.ok, true)
    assert.deepEqual(value.value, { a: 1, b: "x" })

    const invalid = readJsonObject(
        request({ method: "POST", body: Buffer.from("{oops").toString("base64") }),
        MAX_BODY,
    )
    assert.equal(invalid.response?.status, 400)
    assert.match(String(invalid.response?.body), /JSON/)

    const array = readJsonObject(writeRequest([1, 2]), MAX_BODY)
    assert.equal(array.response?.status, 400)

    const tooLarge = readJsonObject(
        request({
            method: "POST",
            headers: { "content-length": String(MAX_BODY + 1) },
            body: payloadOf({ a: 1 }),
        }),
        MAX_BODY,
    )
    assert.equal(tooLarge.response?.status, 413)
})

test("响应辅助：JSON 头、错误体、安全头与 CSP", () => {
    const json = jsonResponse(200, { ok: true })
    assert.equal(json.status, 200)
    assert.equal(json.headers?.["content-type"], "application/json; charset=utf-8")
    assert.equal(json.headers?.["cache-control"], "no-store")
    assert.equal(json.body, '{"ok":true}')
    assert.equal(Number(json.headers?.["content-length"]), Buffer.byteLength(String(json.body)))

    const error = errorResponse(409, "会话正在运行", "busy")
    assert.deepEqual(JSON.parse(String(error.body)), { error: "会话正在运行", code: "busy" })
    assert.equal(errorResponse(404, "未找到").body, '{"error":"未找到"}')

    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
        assert.equal(json.headers?.[key], value)
    }
    const html = applySecurityHeaders({ status: 200, headers: {}, body: "" }, { html: true })
    assert.equal(html.headers?.["content-security-policy"], CONTENT_SECURITY_POLICY)
    assert.match(CONTENT_SECURITY_POLICY, /base-uri 'self'/)
    const plain = applySecurityHeaders({ status: 200, headers: {}, body: "" })
    assert.equal(plain.headers?.["content-security-policy"], undefined)
})

test("SSE：响应头、数据帧与心跳", () => {
    const response: HttpResponse = sseResponse()
    assert.equal(response.stream, true)
    assert.equal(response.headers?.["content-type"], "text/event-stream; charset=utf-8")
    assert.equal(response.headers?.["cache-control"], "no-store")
    assert.equal(response.headers?.["x-accel-buffering"], "no")
    assert.equal(sseChunk({ type: "delta", text: "hi" }), 'data: {"type":"delta","text":"hi"}\n\n')
    assert.equal(SSE_PING_CHUNK, ": ping\n\n")
})
