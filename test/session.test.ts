import assert from "node:assert/strict"
import { test } from "node:test"

import type { HttpRequest, HttpResponse } from "wellspring/api/host/index.ts"

import { checkSession, redirectTargetOf } from "../src/session.ts"
import { createSsoClient, type SsoClient, type SsoResult } from "../src/sso-client.ts"

const GATEWAY_URL = "http://127.0.0.1:8780"

function request(
    url: string,
    options: { method?: string; headers?: Record<string, string> } = {},
): HttpRequest {
    return {
        method: options.method ?? "GET",
        url,
        headers: options.headers ?? {},
        body: "",
        remoteAddress: "127.0.0.1",
    }
}

function loopbackHeaders(cookie?: string): Record<string, string> {
    return {
        accept: "text/html",
        host: "127.0.0.1:8787",
        ...(cookie === undefined ? {} : { cookie }),
    }
}

function fakeSso(verify: () => Promise<SsoResult>): SsoClient {
    const base = createSsoClient({ gatewayUrl: GATEWAY_URL })
    return { ...base, verify }
}

function bodyOf(response: HttpResponse): string {
    if (response.bodyEncoding === "base64") {
        return Buffer.from(response.body ?? "", "base64").toString("utf8")
    }
    return response.body ?? ""
}

test("网关代理请求直接放行，用户取自网关头", async () => {
    let verified = false
    const sso = fakeSso(async () => {
        verified = true
        return { ok: false, reason: "missing" }
    })
    const decision = await checkSession(
        request("/deep/link", {
            headers: {
                host: "127.0.0.1:8780",
                "x-wellspring-gateway": "1",
                "x-wellspring-user": "admin",
            },
        }),
        sso,
    )
    assert.deepEqual(decision, { ok: true, user: "admin" })
    assert.equal(verified, false)
})

test("网关 public 路由的请求用户为空", async () => {
    const sso = fakeSso(async () => ({ ok: false, reason: "missing" }))
    const decision = await checkSession(
        request("/", { headers: { host: "127.0.0.1:8780", "x-wellspring-gateway": "1" } }),
        sso,
    )
    assert.deepEqual(decision, { ok: true, user: null })
})

test("伪造网关头：Host 不受信任时 403", async () => {
    const sso = fakeSso(async () => ({ ok: false, reason: "missing" }))
    for (const host of [undefined, "evil.example:8787", "127.0.0.1.evil.example:8787"]) {
        const headers: Record<string, string> = {
            "x-wellspring-gateway": "1",
            "x-wellspring-user": "admin",
        }
        if (host !== undefined) {
            headers["host"] = host
        }
        const decision = await checkSession(request("/", { headers }), sso)
        assert.equal(decision.ok, false)
        if (!decision.ok) {
            assert.equal(decision.reason, "untrusted-host")
            assert.equal(decision.response.status, 403)
        }
    }
})

test("Host 白名单可配置，允许自定义主机名", async () => {
    const sso = fakeSso(async () => ({ ok: false, reason: "missing" }))
    const headers = { host: "web.example.com:8787", "x-wellspring-gateway": "1" }
    const rejected = await checkSession(request("/", { headers }), sso)
    assert.equal(rejected.ok, false)
    const allowed = await checkSession(request("/", { headers }), sso, {
        allowedHosts: ["web.example.com"],
    })
    assert.deepEqual(allowed, { ok: true, user: null })
})

test("直连有效会话放行", async () => {
    const captured: Array<Record<string, string | string[] | undefined>> = []
    const sso = fakeSso(async () => ({ ok: true, user: "admin", expiresAt: 123 }))
    const client: SsoClient = {
        ...sso,
        verify: async (headers) => {
            captured.push(headers)
            return { ok: true, user: "admin", expiresAt: 123 }
        },
    }
    const decision = await checkSession(
        request("/", { headers: loopbackHeaders("wellspring_session=valid-token") }),
        client,
    )
    assert.deepEqual(decision, { ok: true, user: "admin" })
    assert.equal(captured[0]?.["cookie"], "wellspring_session=valid-token")
})

test("直连未登录 HTML 请求跳网关登录页，next 为当前地址", async () => {
    const sso = fakeSso(async () => ({ ok: false, reason: "missing" }))
    const decision = await checkSession(
        request("/deep/link?x=1", {
            headers: { accept: "text/html", host: "127.0.0.1:8787" },
        }),
        sso,
    )
    assert.equal(decision.ok, false)
    if (decision.ok) {
        return
    }
    assert.equal(decision.reason, "missing")
    assert.equal(decision.response.status, 302)
    assert.equal(
        decision.response.headers?.["location"],
        `${GATEWAY_URL}/login?redirect=${encodeURIComponent("127.0.0.1:8787/deep/link?x=1")}`,
    )
    assert.equal(bodyOf(decision.response), "")
})


test("登录地址主机名只在 Host 白名单内替换，局域网 IP 需配置 allowedHosts", async () => {
    const sso = fakeSso(async () => ({ ok: false, reason: "missing" }))
    const lanHeaders = { accept: "text/html", host: "192.168.31.138:8787" }

    const rejected = await checkSession(request("/deep?x=1", { headers: lanHeaders }), sso)
    assert.equal(rejected.ok, false)
    if (!rejected.ok) {
        assert.equal(rejected.response.headers?.["location"], `${GATEWAY_URL}/login`)
    }

    const allowed = await checkSession(request("/deep?x=1", { headers: lanHeaders }), sso, {
        allowedHosts: ["192.168.31.138"],
    })
    assert.equal(allowed.ok, false)
    if (!allowed.ok) {
        assert.equal(
            allowed.response.headers?.["location"],
            `http://192.168.31.138:8780/login?redirect=${encodeURIComponent("192.168.31.138:8787/deep?x=1")}`,
        )
    }

    const localhost = await checkSession(
        request("/", { headers: { accept: "text/html", host: "localhost:8787" } }),
        sso,
    )
    assert.equal(localhost.ok, false)
    if (!localhost.ok) {
        assert.equal(
            localhost.response.headers?.["location"],
            `http://localhost:8780/login?redirect=${encodeURIComponent("localhost:8787/")}`,
        )
    }

    /* 不可信 Host 回退网关地址且不带 redirect */
    const rebinding = await checkSession(
        request("/", { headers: { accept: "text/html", host: "evil.example:8787" } }),
        sso,
    )
    assert.equal(rebinding.ok, false)
    if (!rebinding.ok) {
        assert.equal(rebinding.response.headers?.["location"], `${GATEWAY_URL}/login`)
    }
})

test("https 网关下直连 http 端口返回 503，不跳转", async () => {
    const sso = createSsoClient({ gatewayUrl: "https://127.0.0.1:8780" })
    const client: SsoClient = { ...sso, verify: async () => ({ ok: false, reason: "missing" }) }
    const decision = await checkSession(
        request("/", { headers: loopbackHeaders() }),
        client,
    )
    assert.equal(decision.ok, false)
    if (!decision.ok) {
        assert.equal(decision.response.status, 503)
        assert.equal(decision.response.headers?.["location"], undefined)
    }
})

test("浏览器默认 Accept 按页面跳转", async () => {
    const sso = fakeSso(async () => ({ ok: false, reason: "missing" }))
    const decision = await checkSession(
        request("/", { headers: { accept: "*/*", host: "127.0.0.1:8787" } }),
        sso,
    )
    assert.equal(decision.ok, false)
    if (!decision.ok) {
        assert.equal(decision.response.status, 302)
    }
})

test("直连未登录 API 请求返回 401 JSON", async () => {
    const sso = fakeSso(async () => ({ ok: false, reason: "invalid" }))
    const decision = await checkSession(
        request("/api/data", {
            headers: { accept: "application/json", host: "127.0.0.1:8787" },
        }),
        sso,
    )
    assert.equal(decision.ok, false)
    if (decision.ok) {
        return
    }
    assert.equal(decision.reason, "invalid")
    assert.equal(decision.response.status, 401)
    assert.match(String(decision.response.headers?.["content-type"]), /application\/json/)
    assert.deepEqual(JSON.parse(bodyOf(decision.response)), { error: "unauthorized" })
})

test("同一 token 重复校验失败返回 503，终止回跳循环", async () => {
    const sso = fakeSso(async () => ({ ok: false, reason: "invalid" }))
    const headers = loopbackHeaders("wellspring_session=loop-token")
    const first = await checkSession(request("/page", { headers }), sso)
    assert.equal(first.ok, false)
    if (!first.ok) {
        assert.equal(first.response.status, 302)
    }
    const second = await checkSession(request("/page", { headers }), sso)
    assert.equal(second.ok, false)
    if (!second.ok) {
        assert.equal(second.reason, "loop")
        assert.equal(second.response.status, 503)
        assert.equal(second.response.headers?.["location"], undefined)
        assert.equal(second.response.headers?.["cache-control"], "no-store")
    }
})

test("不同 token 或校验通过后不触发循环保护", async () => {
    let valid = false
    const sso = fakeSso(async () =>
        valid ? { ok: true, user: "admin", expiresAt: 123 } : { ok: false, reason: "invalid" },
    )
    const headers = loopbackHeaders("wellspring_session=recovery-token")
    const first = await checkSession(request("/page", { headers }), sso)
    assert.equal(first.ok, false)
    if (!first.ok) {
        assert.equal(first.response.status, 302)
    }
    valid = true
    const recovered = await checkSession(request("/page", { headers }), sso)
    assert.deepEqual(recovered, { ok: true, user: "admin" })
    valid = false
    const again = await checkSession(request("/page", { headers }), sso)
    assert.equal(again.ok, false)
    if (!again.ok) {
        assert.equal(again.response.status, 302)
    }
})

test("会话快照不可读返回 503，不跳登录页", async () => {
    const sso = fakeSso(async () => ({ ok: false, reason: "unreachable" }))
    const decision = await checkSession(request("/", { headers: loopbackHeaders() }), sso)
    assert.equal(decision.ok, false)
    if (!decision.ok) {
        assert.equal(decision.reason, "unreachable")
        assert.equal(decision.response.status, 503)
        assert.equal(decision.response.headers?.["cache-control"], "no-store")
        assert.equal(decision.response.headers?.["location"], undefined)
    }
})

test("Host 头缺失时跳登录页，无 next 参数", async () => {
    const sso = fakeSso(async () => ({ ok: false, reason: "missing" }))
    const decision = await checkSession(request("/", { headers: { accept: "text/html" } }), sso)
    assert.equal(decision.ok, false)
    if (!decision.ok) {
        assert.equal(decision.response.headers?.["location"], `${GATEWAY_URL}/login`)
    }
})

test("无网关发现文件时直连请求不做校验", async () => {
    const decision = await checkSession(request("/"), null)
    assert.deepEqual(decision, { ok: true, user: null })
})

test("发现文件异常时 failClosed 拒绝直连请求", async () => {
    const decision = await checkSession(request("/"), null, { failClosed: true })
    assert.equal(decision.ok, false)
    if (!decision.ok) {
        assert.equal(decision.reason, "unavailable")
        assert.equal(decision.response.status, 503)
    }
})

test("网关关闭鉴权时直连请求放行", async () => {
    const sso = createSsoClient({ gatewayUrl: GATEWAY_URL, authEnabled: false })
    const decision = await checkSession(
        request("/", { headers: loopbackHeaders("wellspring_session=expired") }),
        sso,
    )
    assert.deepEqual(decision, { ok: true, user: null })
})

test("头名大小写不敏感", async () => {
    const sso = fakeSso(async () => ({ ok: false, reason: "missing" }))
    const decision = await checkSession(
        request("/", {
            headers: {
                host: "127.0.0.1:8780",
                "X-WellSpring-Gateway": "1",
                "X-Wellspring-User": "admin",
            },
        }),
        sso,
    )
    assert.deepEqual(decision, { ok: true, user: "admin" })
})


test("非页面请求重复失败仍返回 401，不触发循环保护", async () => {
    const sso = fakeSso(async () => ({ ok: false, reason: "invalid" }))
    const headers = {
        accept: "application/json",
        host: "127.0.0.1:8787",
        cookie: "wellspring_session=api-loop-token",
    }
    for (let round = 0; round < 3; round += 1) {
        const decision = await checkSession(request("/api/data", { headers }), sso)
        assert.equal(decision.ok, false)
        if (!decision.ok) {
            assert.equal(decision.response.status, 401)
        }
    }
})

test("不同 token 的循环保护互相隔离", async () => {
    const sso = fakeSso(async () => ({ ok: false, reason: "invalid" }))
    const first = await checkSession(
        request("/", { headers: loopbackHeaders("wellspring_session=isolate-a") }),
        sso,
    )
    assert.equal(first.ok, false)
    if (!first.ok) {
        assert.equal(first.response.status, 302)
    }
    const otherFirst = await checkSession(
        request("/", { headers: loopbackHeaders("wellspring_session=isolate-b") }),
        sso,
    )
    assert.equal(otherFirst.ok, false)
    if (!otherFirst.ok) {
        assert.equal(otherFirst.response.status, 302)
    }
    const repeat = await checkSession(
        request("/", { headers: loopbackHeaders("wellspring_session=isolate-a") }),
        sso,
    )
    assert.equal(repeat.ok, false)
    if (!repeat.ok) {
        assert.equal(repeat.response.status, 503)
    }
})

test("循环记忆超过上限时淘汰最旧 token", async () => {
    const sso = fakeSso(async () => ({ ok: false, reason: "invalid" }))
    for (let index = 0; index < 260; index += 1) {
        await checkSession(
            request("/", { headers: loopbackHeaders(`wellspring_session=bulk-${index}`) }),
            sso,
        )
    }
    const oldest = await checkSession(
        request("/", { headers: loopbackHeaders("wellspring_session=bulk-0") }),
        sso,
    )
    assert.equal(oldest.ok, false)
    if (!oldest.ok) {
        assert.equal(oldest.response.status, 302)
    }
    const newest = await checkSession(
        request("/", { headers: loopbackHeaders("wellspring_session=bulk-259") }),
        sso,
    )
    assert.equal(newest.ok, false)
    if (!newest.ok) {
        assert.equal(newest.response.status, 503)
    }
})

test("Host 头为空时跳登录页，无 next 参数", async () => {
    const sso = fakeSso(async () => ({ ok: false, reason: "missing" }))
    const decision = await checkSession(
        request("/", { headers: { accept: "text/html", host: "" } }),
        sso,
    )
    assert.equal(decision.ok, false)
    if (!decision.ok) {
        assert.equal(decision.response.headers?.["location"], `${GATEWAY_URL}/login`)
    }
})

test("redirectTargetOf：拼接 Host 与路径，拒绝控制字符", () => {
    assert.equal(
        redirectTargetOf(request("/deep?x=1", { headers: { host: "127.0.0.1:8787" } })),
        "127.0.0.1:8787/deep?x=1",
    )
    assert.equal(
        redirectTargetOf(request("", { headers: { host: "127.0.0.1:8787" } })),
        "127.0.0.1:8787/",
    )
    assert.equal(redirectTargetOf(request("/", { headers: { host: "127.0.0.1:8787\r\nx: y" } })), null)
    assert.equal(redirectTargetOf(request("/", { headers: { host: "127.0.0.1:8787 x" } })), null)
    assert.equal(redirectTargetOf(request("/")), null)
})
