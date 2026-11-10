import assert from "node:assert/strict"
import { test } from "node:test"

import type { HttpRequest, HttpResponse } from "wellspring/api/host/index.ts"

import { serveStatic, type StaticOptions } from "../src/static.ts"
import { MemoryFs } from "./helpers/memory-fs.ts"

function request(
    url: string,
    options: { method?: string; headers?: Record<string, string> } = {},
): HttpRequest {
    return {
        method: options.method ?? "GET",
        url,
        headers: options.headers ?? {},
        body: "",
        remoteAddress: null,
    }
}

function textOf(response: HttpResponse): string {
    if (response.bodyEncoding === "base64") {
        return Buffer.from(response.body ?? "", "base64").toString("utf8")
    }
    return response.body ?? ""
}

const fs = new MemoryFs({
    "www/index.html": "<!doctype html><h1>home</h1>",
    "www/style.css": "body { margin: 0 }",
    "www/assets/app.js": "console.log('app')",
    "www/data.json": '{"a":1}',
    "www/img.png": Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
    "www/.env": "SECRET",
    "www/sub/index.html": "<h1>sub</h1>",
    "secret.txt": "top secret",
})

const options: StaticOptions = { root: "www", spaFallback: false }

test("目录默认返回 index.html", async () => {
    const response = await serveStatic(request("/"), fs, options)
    assert.equal(response.status, 200)
    assert.match(String(response.headers?.["content-type"]), /text\/html/)
    assert.match(textOf(response), /home/)
})

test("按扩展名返回 MIME", async () => {
    const css = await serveStatic(request("/style.css"), fs, options)
    assert.match(String(css.headers?.["content-type"]), /text\/css/)
    const js = await serveStatic(request("/assets/app.js"), fs, options)
    assert.match(String(js.headers?.["content-type"]), /application\/javascript/)
    const json = await serveStatic(request("/data.json"), fs, options)
    assert.match(String(json.headers?.["content-type"]), /application\/json/)
})

test("二进制文件用 base64 返回", async () => {
    const response = await serveStatic(request("/img.png"), fs, options)
    assert.equal(response.status, 200)
    assert.equal(response.bodyEncoding, "base64")
    assert.deepEqual(
        [...Buffer.from(response.body ?? "", "base64")],
        [0x89, 0x50, 0x4e, 0x47],
    )
})

test("未知路径 404，隐藏文件不可见", async () => {
    assert.equal((await serveStatic(request("/missing"), fs, options)).status, 404)
    assert.equal((await serveStatic(request("/.env"), fs, options)).status, 404)
    assert.equal((await serveStatic(request("/%2e%2e/secret.txt"), fs, options)).status, 404)
})

test("非法路径 400", async () => {
    const response = await serveStatic(request("/%5C..%5Csecret.txt"), fs, options)
    assert.equal(response.status, 400)
})

test("HEAD 不返回 body", async () => {
    const response = await serveStatic(request("/style.css", { method: "HEAD" }), fs, options)
    assert.equal(response.status, 200)
    assert.equal(response.body, "")
    assert.ok(Number(response.headers?.["content-length"]) > 0)
})

test("POST 返回 405", async () => {
    const response = await serveStatic(request("/", { method: "POST" }), fs, options)
    assert.equal(response.status, 405)
})

test("目录路径补斜杠重定向", async () => {
    const response = await serveStatic(request("/sub"), fs, options)
    assert.equal(response.status, 301)
    assert.equal(response.headers?.["location"], "/sub/")
    const withSlash = await serveStatic(request("/sub/"), fs, options)
    assert.equal(withSlash.status, 200)
    assert.match(textOf(withSlash), /sub/)
})

test("ETag 命中返回 304", async () => {
    const first = await serveStatic(request("/style.css"), fs, options)
    const etag = String(first.headers?.["etag"])
    assert.ok(etag.startsWith("W/"))
    const second = await serveStatic(
        request("/style.css", { headers: { "if-none-match": etag } }),
        fs,
        options,
    )
    assert.equal(second.status, 304)
})

test("SPA 回退：只有接受 HTML 时回 index.html", async () => {
    const spa: StaticOptions = { root: "www", spaFallback: true }
    const html = await serveStatic(
        request("/client/route", { headers: { accept: "text/html" } }),
        fs,
        spa,
    )
    assert.equal(html.status, 200)
    assert.match(textOf(html), /home/)
    const other = await serveStatic(
        request("/client/route", { headers: { accept: "application/json" } }),
        fs,
        spa,
    )
    assert.equal(other.status, 404)
})

test("未知扩展名回退 octet-stream", async () => {
    const withBinary = new MemoryFs({ "www/file.bin": Uint8Array.from([1, 2, 3]) })
    const response = await serveStatic(request("/file.bin"), withBinary, options)
    assert.equal(response.status, 200)
    assert.equal(response.headers?.["content-type"], "application/octet-stream")
})
