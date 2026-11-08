import assert from "node:assert/strict"
import { test } from "node:test"

import type { HttpRequest, HttpResponse } from "wellspring/api/host/index.ts"

import { CONTENT_SECURITY_POLICY } from "../src/security.ts"
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

const ROOT = "/srv/www"

const fs = new MemoryFs({
    [`${ROOT}/index.html`]:
        '<!doctype html><html data-theme="{{theme}}"><head><base href="./" /><meta charset="utf-8"></head><body><h1>home</h1></body></html>',
    [`${ROOT}/style.css`]: "body { margin: 0 }",
    [`${ROOT}/assets/app-ABCD1234.js`]: "console.log('app')",
    [`${ROOT}/assets/plain.js`]: "console.log('plain')",
    [`${ROOT}/data.json`]: '{"a":1}',
    [`${ROOT}/img.png`]: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
    [`${ROOT}/.env`]: "SECRET",
    [`${ROOT}/sub/index.html`]:
        '<html data-theme="{{theme}}"><head><base href="./" /></head><body><h1>sub</h1></body></html>',
    [`${ROOT}/sub/page.txt`]: "page",
    "/etc/secret.txt": "top secret",
})

const options: StaticOptions = { root: ROOT, spaFallback: false }

test("目录默认返回 index.html，注入主题 cookie", async () => {
    const response = await serveStatic(request("/"), fs, options)
    assert.equal(response.status, 200)
    assert.match(String(response.headers?.["content-type"]), /text\/html/)
    assert.match(textOf(response), /<h1>home<\/h1>/)
    assert.match(textOf(response), /data-theme=""/)

    const dark = await serveStatic(
        request("/", { headers: { cookie: "wellspring_web_theme=dark" } }),
        fs,
        options,
    )
    assert.match(textOf(dark), /data-theme="dark"/)
    const light = await serveStatic(
        request("/index.html", { headers: { cookie: "wellspring_web_theme=light; other=1" } }),
        fs,
        options,
    )
    assert.match(textOf(light), /data-theme="light"/)
    const junk = await serveStatic(
        request("/", { headers: { cookie: "wellspring_web_theme=system" } }),
        fs,
        options,
    )
    assert.match(textOf(junk), /data-theme=""/)
})

test("HTML：no-store、vary cookie、安全头与 CSP", async () => {
    const response = await serveStatic(request("/"), fs, options)
    assert.equal(response.headers?.["cache-control"], "no-store")
    assert.equal(response.headers?.["vary"], "cookie")
    assert.equal(response.headers?.["content-security-policy"], CONTENT_SECURITY_POLICY)
    assert.equal(response.headers?.["x-content-type-options"], "nosniff")
    assert.equal(response.headers?.["referrer-policy"], "no-referrer")
    assert.equal(response.headers?.["x-frame-options"], "DENY")
    assert.equal(response.headers?.["etag"], undefined)
})

test("base 注入：网关注入前缀、直连根、非法值回退", async () => {
    const proxied = await serveStatic(
        request("/", { headers: { "x-forwarded-prefix": "/web" } }),
        fs,
        options,
    )
    assert.match(textOf(proxied), /<base href="\/web\/" \/>/)
    assert.equal(textOf(proxied).match(/<base\b/g)?.length, 1)
    assert.doesNotMatch(textOf(proxied), /href="\.\/"/)

    const direct = await serveStatic(request("/"), fs, options)
    assert.match(textOf(direct), /<base href="\/" \/>/)

    for (const prefix of ["web", "/we b", "http://x", "/%2e%2e/x", "/a".repeat(200)]) {
        const response = await serveStatic(
            request("/", { headers: { "x-forwarded-prefix": prefix } }),
            fs,
            options,
        )
        assert.match(textOf(response), /<base href="\/" \/>/, prefix)
    }

    const normalized = await serveStatic(
        request("/", { headers: { "x-forwarded-prefix": "/a/../b/./c/" } }),
        fs,
        options,
    )
    assert.match(textOf(normalized), /<base href="\/a\/b\/c\/" \/>/)
})

test("base 注入：SPA 回退同样生效", async () => {
    const spa: StaticOptions = { root: ROOT, spaFallback: true }
    const response = await serveStatic(
        request("/client/route", {
            headers: { accept: "text/html", "x-forwarded-prefix": "/web" },
        }),
        fs,
        spa,
    )
    assert.equal(response.status, 200)
    assert.match(textOf(response), /<base href="\/web\/" \/>/)
    assert.match(textOf(response), /<h1>home<\/h1>/)
})

test("base 注入：旧构建没有占位时补在 head 后", async () => {
    const legacy = new MemoryFs({
        [`${ROOT}/index.html`]: '<!doctype html><html><head><meta charset="utf-8"></head><body>old</body></html>',
    })
    const response = await serveStatic(
        request("/", { headers: { "x-forwarded-prefix": "/web" } }),
        legacy,
        options,
    )
    const html = textOf(response)
    assert.match(html, /<head>\n<base href="\/web\/" \/>/)
    assert.equal(html.match(/<base\b/g)?.length, 1)
})

test("模板缓存：同 fs 上按文件内容签名失效", async () => {
    const local = new MemoryFs({
        [`${ROOT}/index.html`]: '<html data-theme="{{theme}}"><h1>v1</h1></html>',
    })
    const first = await serveStatic(request("/"), local, options)
    assert.match(textOf(first), /<h1>v1<\/h1>/)
    local.addFile(
        `${ROOT}/index.html`,
        '<html data-theme="{{theme}}"><h1>version-2</h1></html>',
        2_000,
    )
    const second = await serveStatic(request("/"), local, options)
    assert.match(textOf(second), /<h1>version-2<\/h1>/)
})

test("按扩展名返回 MIME", async () => {
    const css = await serveStatic(request("/style.css"), fs, options)
    assert.match(String(css.headers?.["content-type"]), /text\/css/)
    const js = await serveStatic(request("/assets/app-ABCD1234.js"), fs, options)
    assert.match(String(js.headers?.["content-type"]), /application\/javascript/)
    const json = await serveStatic(request("/data.json"), fs, options)
    assert.match(String(json.headers?.["content-type"]), /application\/json/)
})

test("缓存策略：hashed assets 长缓存，其余短缓存", async () => {
    const hashed = await serveStatic(request("/assets/app-ABCD1234.js"), fs, options)
    assert.equal(hashed.headers?.["cache-control"], "public, max-age=31536000, immutable")
    const plainAsset = await serveStatic(request("/assets/plain.js"), fs, options)
    assert.equal(plainAsset.headers?.["cache-control"], "public, max-age=300")
    const css = await serveStatic(request("/style.css"), fs, options)
    assert.equal(css.headers?.["cache-control"], "public, max-age=300")
})

test("二进制文件用 base64 返回", async () => {
    const response = await serveStatic(request("/img.png"), fs, options)
    assert.equal(response.status, 200)
    assert.equal(response.bodyEncoding, "base64")
    assert.deepEqual([...Buffer.from(response.body ?? "", "base64")], [0x89, 0x50, 0x4e, 0x47])
})

test("未知路径 404，隐藏文件与越界路径不可见", async () => {
    assert.equal((await serveStatic(request("/missing"), fs, options)).status, 404)
    assert.equal((await serveStatic(request("/.env"), fs, options)).status, 404)
    assert.equal((await serveStatic(request("/%2e%2e/etc/secret.txt"), fs, options)).status, 404)
    assert.equal((await serveStatic(request("/../etc/secret.txt"), fs, options)).status, 404)
})

test("非法路径 400", async () => {
    const response = await serveStatic(request("/%5C..%5Csecret.txt"), fs, options)
    assert.equal(response.status, 400)
    const badEncoding = await serveStatic(request("/%E0%A4%A"), fs, options)
    assert.equal(badEncoding.status, 400)
})

test("HEAD 不返回 body，但带 content-length 与 CSP", async () => {
    const response = await serveStatic(request("/", { method: "HEAD" }), fs, options)
    assert.equal(response.status, 200)
    assert.equal(response.body, "")
    assert.ok(Number(response.headers?.["content-length"]) > 0)
    assert.equal(response.headers?.["content-security-policy"], CONTENT_SECURITY_POLICY)

    const asset = await serveStatic(request("/style.css", { method: "HEAD" }), fs, options)
    assert.equal(asset.status, 200)
    assert.equal(asset.body, "")
    assert.ok(Number(asset.headers?.["content-length"]) > 0)
})

test("POST 返回 405", async () => {
    const response = await serveStatic(request("/", { method: "POST" }), fs, options)
    assert.equal(response.status, 405)
    assert.equal(response.headers?.["allow"], "GET, HEAD")
})

test("目录路径补斜杠重定向", async () => {
    const response = await serveStatic(request("/sub"), fs, options)
    assert.equal(response.status, 301)
    assert.equal(response.headers?.["location"], "/sub/")
    const withQuery = await serveStatic(request("/sub?x=1"), fs, options)
    assert.equal(withQuery.headers?.["location"], "/sub/?x=1")
    const withSlash = await serveStatic(request("/sub/"), fs, options)
    assert.equal(withSlash.status, 200)
    assert.match(textOf(withSlash), /sub/)
})

test("ETag 命中返回 304，非 HTML 才带 ETag", async () => {
    const first = await serveStatic(request("/style.css"), fs, options)
    const etag = String(first.headers?.["etag"])
    assert.ok(etag.startsWith("W/"))
    const second = await serveStatic(
        request("/style.css", { headers: { "if-none-match": etag } }),
        fs,
        options,
    )
    assert.equal(second.status, 304)
    assert.equal(second.body, "")
    assert.equal(second.headers?.["etag"], etag)
})

test("SPA 回退：只有接受 HTML 时回 index.html", async () => {
    const spa: StaticOptions = { root: ROOT, spaFallback: true }
    const html = await serveStatic(request("/client/route", { headers: { accept: "text/html" } }), fs, spa)
    assert.equal(html.status, 200)
    assert.match(textOf(html), /home/)
    const wildcard = await serveStatic(request("/client/route", { headers: { accept: "*/*" } }), fs, spa)
    assert.equal(wildcard.status, 200)
    const other = await serveStatic(
        request("/client/route", { headers: { accept: "application/json" } }),
        fs,
        spa,
    )
    assert.equal(other.status, 404)
    assert.equal((await serveStatic(request("/client/route"), fs, spa)).status, 404)
})

test("前端产物缺失：根路径与 SPA 回退返回提示页而非 500", async () => {
    const empty = new MemoryFs()
    const spa: StaticOptions = { root: ROOT, spaFallback: true }
    for (const path of ["/", "/index.html", "/client/route"]) {
        const response = await serveStatic(request(path, { headers: { accept: "text/html" } }), empty, spa)
        assert.equal(response.status, 503, path)
        assert.match(String(response.headers?.["content-type"]), /text\/html/)
        assert.match(textOf(response), /前端产物缺失/)
        assert.equal(response.headers?.["x-content-type-options"], "nosniff")
    }
    const notFound = await serveStatic(request("/missing"), empty, spa)
    assert.equal(notFound.status, 404)
})

test("未知扩展名回退 octet-stream", async () => {
    const withBinary = new MemoryFs({ [`${ROOT}/file.bin`]: Uint8Array.from([1, 2, 3]) })
    const response = await serveStatic(request("/file.bin"), withBinary, options)
    assert.equal(response.status, 200)
    assert.equal(response.headers?.["content-type"], "application/octet-stream")
})

test("root 末尾分隔符与相对路径（测试用）都能解析", async () => {
    const relative = new MemoryFs({ "www/index.html": "<h1>rel</h1>" })
    const response = await serveStatic(request("/"), relative, { root: "www/", spaFallback: false })
    assert.equal(response.status, 200)
    assert.match(textOf(response), /rel/)
})
