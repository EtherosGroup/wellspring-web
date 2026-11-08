import assert from "node:assert/strict"
import { test } from "node:test"

import { PLUGIN_WWW_DIR } from "../src/assets.ts"
import { DEFAULT_CHAT_LIMITS } from "../src/chat-types.ts"
import {
    DEFAULT_ALLOWED_HOSTS,
    DEFAULT_WEB_CONFIG,
    normalizeHost,
    parseWebConfig,
} from "../src/config.ts"

test("默认配置：loopback、插件 www、SPA 回退、默认限额", () => {
    const { config, warnings } = parseWebConfig(undefined)
    assert.deepEqual(config, DEFAULT_WEB_CONFIG)
    assert.deepEqual(config.allowedHosts, DEFAULT_ALLOWED_HOSTS)
    assert.deepEqual([...DEFAULT_ALLOWED_HOSTS], ["127.0.0.1", "localhost", "[::1]"])
    assert.equal(config.wwwDir, PLUGIN_WWW_DIR)
    assert.equal(config.spaFallback, true)
    assert.deepEqual(config.limits, DEFAULT_CHAT_LIMITS)
    assert.deepEqual(warnings, [])
})

test("normalizeHost：主机名、端口与 IPv6", () => {
    assert.equal(normalizeHost("127.0.0.1"), "127.0.0.1")
    assert.equal(normalizeHost("LOCALHOST:8787"), "localhost")
    assert.equal(normalizeHost("[::1]:8787"), "[::1]")
    assert.equal(normalizeHost("::1"), "[::1]")
    assert.equal(normalizeHost(""), null)
    assert.equal(normalizeHost("bad host"), null)
    assert.equal(normalizeHost("http://127.0.0.1"), null)
})

test("allowedHosts：默认项保留，自定义主机名追加并去重", () => {
    const { config, warnings } = parseWebConfig({
        allowedHosts: ["WEB.Example.com", "192.168.1.5:8780", "::1", "localhost", "bad host", 42],
    })
    assert.deepEqual(config.allowedHosts, [
        "127.0.0.1",
        "localhost",
        "[::1]",
        "web.example.com",
        "192.168.1.5",
    ])
    assert.equal(warnings.length, 2)
})

test("allowedHosts：非数组回落默认并警告，空数组与重复默认项不告警", () => {
    const notArray = parseWebConfig({ allowedHosts: "web.example.com" })
    assert.deepEqual(notArray.config.allowedHosts, DEFAULT_ALLOWED_HOSTS)
    assert.ok(notArray.warnings.some((warning) => warning.includes("allowedHosts")))

    for (const value of [[], ["127.0.0.1", "localhost", "[::1]"], ["localhost"]]) {
        const { config, warnings } = parseWebConfig({ allowedHosts: value })
        assert.deepEqual(config.allowedHosts, DEFAULT_ALLOWED_HOSTS)
        assert.deepEqual(warnings, [], JSON.stringify(value))
    }
})

test("normalizeHost：去掉域名尾点", () => {
    assert.equal(normalizeHost("localhost.:8787"), "localhost")
    assert.equal(normalizeHost("web.example.com."), "web.example.com")
})

test("host / port / routePrefix：合法值生效，非法值警告并回落", () => {
    const custom = parseWebConfig({ host: "0.0.0.0", port: 9000, routePrefix: "/chat/" })
    assert.equal(custom.config.host, "0.0.0.0")
    assert.equal(custom.config.port, 9000)
    assert.equal(custom.config.routePrefix, "/chat")
    assert.deepEqual(custom.warnings, [])

    const invalid = parseWebConfig({
        host: "bad host",
        port: 70_000,
        routePrefix: "web",
        wwwDir: 42,
        spaFallback: "yes",
        limits: "small",
    })
    assert.equal(invalid.config.host, DEFAULT_WEB_CONFIG.host)
    assert.equal(invalid.config.port, DEFAULT_WEB_CONFIG.port)
    assert.equal(invalid.config.routePrefix, DEFAULT_WEB_CONFIG.routePrefix)
    assert.equal(invalid.config.wwwDir, PLUGIN_WWW_DIR)
    assert.equal(invalid.config.spaFallback, true)
    assert.deepEqual(invalid.config.limits, DEFAULT_CHAT_LIMITS)
    assert.equal(invalid.warnings.length, 6)
})

test("wwwDir：接受绝对路径并去掉尾部分隔符", () => {
    assert.equal(parseWebConfig({ wwwDir: "/srv/wellspring/www" }).config.wwwDir, "/srv/wellspring/www")
    assert.equal(parseWebConfig({ wwwDir: "/srv/www/" }).config.wwwDir, "/srv/www")
    assert.equal(parseWebConfig({ wwwDir: "C:\\srv\\www\\" }).config.wwwDir, "C:\\srv\\www")
})

test("wwwDir：相对路径与空值警告并回落插件目录", () => {
    for (const value of ["web/dist", "", "./www", "  "]) {
        const { config, warnings } = parseWebConfig({ wwwDir: value })
        assert.equal(config.wwwDir, PLUGIN_WWW_DIR, value)
        assert.ok(warnings.some((warning) => warning.includes("wwwDir")), value)
    }
})

test("spaFallback：false 生效", () => {
    const { config, warnings } = parseWebConfig({ spaFallback: false })
    assert.equal(config.spaFallback, false)
    assert.deepEqual(warnings, [])
})

test("limits：部分覆盖与默认合并", () => {
    const { config, warnings } = parseWebConfig({
        limits: { maxMessageChars: 1000, maxReferences: 5, maxBodyBytes: 4096, turnBufferChars: 8192 },
    })
    assert.equal(config.limits.maxMessageChars, 1000)
    assert.equal(config.limits.maxReferences, 5)
    assert.equal(config.limits.maxBodyBytes, 4096)
    assert.equal(config.limits.turnBufferChars, 8192)
    assert.equal(config.limits.maxConversations, DEFAULT_CHAT_LIMITS.maxConversations)
    assert.equal(config.limits.maxConversationChars, DEFAULT_CHAT_LIMITS.maxConversationChars)
    assert.deepEqual(warnings, [])
})

test("limits：非法值与越界值警告并保留默认", () => {
    const { config, warnings } = parseWebConfig({
        limits: {
            maxMessageChars: -1,
            maxReferences: 1.5,
            maxBodyBytes: 17 * 1024 * 1024,
            maxConversations: "100",
            maxConversationChars: 0,
            turnBufferChars: 1,
            unknown: 1,
        },
    })
    assert.deepEqual(config.limits, DEFAULT_CHAT_LIMITS)
    assert.equal(warnings.filter((warning) => warning.includes("limits.")).length, 6)
})
