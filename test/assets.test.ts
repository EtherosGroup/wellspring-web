import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import {
    applyThemeTemplate,
    createPluginStaticFs,
    normalizeTheme,
    PLUGIN_WWW_DIR,
    THEME_COOKIE,
} from "../src/assets.ts"

test("插件 www 目录：位于插件根目录下", () => {
    assert.equal(PLUGIN_WWW_DIR, fileURLToPath(new URL("../www", import.meta.url)))
    assert.ok(PLUGIN_WWW_DIR.endsWith("/www"))
    assert.ok(!PLUGIN_WWW_DIR.endsWith("/"))
})

test("主题取值：light/dark 之外为空", () => {
    assert.equal(THEME_COOKIE, "wellspring_web_theme")
    assert.equal(normalizeTheme("light"), "light")
    assert.equal(normalizeTheme("dark"), "dark")
    assert.equal(normalizeTheme("system"), "")
    assert.equal(normalizeTheme(undefined), "")
    assert.equal(normalizeTheme("DARK"), "")
})

test("模板替换：全部占位与空主题", () => {
    const template = '<html data-theme="{{theme}}"><body data-theme="{{theme}}"></body></html>'
    assert.equal(
        applyThemeTemplate(template, "dark"),
        '<html data-theme="dark"><body data-theme="dark"></body></html>',
    )
    assert.equal(
        applyThemeTemplate(template, "system"),
        '<html data-theme=""><body data-theme=""></body></html>',
    )
    assert.equal(applyThemeTemplate("no placeholder", "light"), "no placeholder")
})

test("进程内静态 fs：读文件、目录与缺失路径", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wellspring-web-assets-"))
    try {
        await writeFile(join(dir, "index.html"), "<h1>home</h1>")
        await mkdir(join(dir, "assets"))
        await writeFile(join(dir, "assets", "app.js"), "console.log(1)")
        const fs = createPluginStaticFs()
        const index = await fs.stat(join(dir, "index.html"))
        assert.deepEqual({ type: index?.type, size: index?.size }, { type: "file", size: 13 })
        assert.equal((await fs.stat(join(dir, "assets")))?.type, "directory")
        assert.equal(await fs.stat(join(dir, "missing.txt")), null)
        assert.equal(
            Buffer.from((await fs.readBytes(join(dir, "index.html"))) ?? []).toString("utf8"),
            "<h1>home</h1>",
        )
        assert.equal(await fs.readBytes(join(dir, "missing.txt")), null)
        assert.equal(await fs.readBytes(dir), null)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test("进程内静态 fs：文件大小变化后重新读取", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wellspring-web-assets-"))
    try {
        const file = join(dir, "app.js")
        await writeFile(file, "v1")
        const fs = createPluginStaticFs()
        assert.equal(Buffer.from((await fs.readBytes(file)) ?? []).toString("utf8"), "v1")
        await writeFile(file, "version-2")
        assert.equal(Buffer.from((await fs.readBytes(file)) ?? []).toString("utf8"), "version-2")
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})
