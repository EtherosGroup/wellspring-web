import assert from "node:assert/strict"
import { test } from "node:test"

import { ensureWww, SEED_FILES } from "../src/assets.ts"
import { MemoryFs } from "./helpers/memory-fs.ts"

test("www 缺失时创建目录并写入占位页", async () => {
    const fs = new MemoryFs()
    const result = await ensureWww(fs, "www")
    assert.equal(result.dirCreated, true)
    assert.deepEqual(result.created, ["index.html"])
    assert.deepEqual(result.skipped, [])
    const index = await fs.text("www/index.html")
    assert.match(index ?? "", /<!doctype html>/)
})

test("已有文件不覆盖", async () => {
    const fs = new MemoryFs({ "www/index.html": "custom" })
    const result = await ensureWww(fs, "www")
    assert.equal(result.dirCreated, false)
    assert.deepEqual(result.skipped, ["index.html"])
    assert.deepEqual(result.created, [])
    assert.equal(await fs.text("www/index.html"), "custom")
})

test("www 路径被文件占用时抛错", async () => {
    const fs = new MemoryFs({ www: "not a dir" })
    await assert.rejects(ensureWww(fs, "www"), /不是目录/)
})

test("占位资源只有 index.html", () => {
    assert.deepEqual(
        SEED_FILES.map((file) => file.name),
        ["index.html"],
    )
})
