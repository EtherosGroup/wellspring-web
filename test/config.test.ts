import assert from "node:assert/strict"
import { test } from "node:test"

import {
    DEFAULT_ALLOWED_HOSTS,
    DEFAULT_WEB_CONFIG,
    normalizeHost,
    parseWebConfig,
} from "../src/config.ts"

test("默认配置：allowedHosts 只信任 loopback", () => {
    const { config, warnings } = parseWebConfig(undefined)
    assert.deepEqual(config, DEFAULT_WEB_CONFIG)
    assert.deepEqual(config.allowedHosts, DEFAULT_ALLOWED_HOSTS)
    assert.deepEqual([...DEFAULT_ALLOWED_HOSTS], ["127.0.0.1", "localhost", "[::1]"])
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
