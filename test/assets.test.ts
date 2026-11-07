import assert from "node:assert/strict"
import { test } from "node:test"

import { ensureWww, SEED_FILES } from "../src/assets.ts"
import { MemoryFs } from "./helpers/memory-fs.ts"

test("www 缺失时创建目录并写入默认资源", async () => {
    const fs = new MemoryFs()
    const result = await ensureWww(fs, "www")
    assert.equal(result.dirCreated, true)
    assert.deepEqual([...result.created].sort(), ["app.js", "index.html", "style.css"])
    assert.deepEqual(result.skipped, [])
    const index = await fs.text("www/index.html")
    assert.match(index ?? "", /<!doctype html>/)
})

test("已有文件不覆盖，其它默认文件补齐", async () => {
    const fs = new MemoryFs({ "www/index.html": "custom" })
    const result = await ensureWww(fs, "www")
    assert.equal(result.dirCreated, false)
    assert.deepEqual(result.skipped, ["index.html"])
    assert.deepEqual([...result.created].sort(), ["app.js", "style.css"])
    assert.equal(await fs.text("www/index.html"), "custom")
})

test("www 路径被文件占用时抛错", async () => {
    const fs = new MemoryFs({ www: "not a dir" })
    await assert.rejects(ensureWww(fs, "www"), /不是目录/)
})

test("默认资源包含 index/style/app", () => {
    assert.deepEqual(
        SEED_FILES.map((file) => file.name),
        ["index.html", "style.css", "app.js"],
    )
})
