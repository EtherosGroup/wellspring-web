/*
 * 插件自带 www 的定位、主题模板与进程内文件读取
 *
 * 插件目录在沙箱里只读挂载在 /plugin（bwrap），src/assets.ts 的 ../www 即 /plugin/www
 * node:fs 的模块级 import 会被 access-guard 的 resolve hook 拒绝，进程内读取走
 * process.getBuiltinModule；它不经过 ESM 解析，是沙箱里读插件目录的既有通道
 */

import { fileURLToPath } from "node:url"

import type { StaticFileStat, StaticFileSystem } from "./static.ts"

/** 插件自带静态资源目录的绝对路径；运行时为 /plugin/www */
export const PLUGIN_WWW_DIR: string = trimTrailingSeparators(
    fileURLToPath(new URL("../www/", import.meta.url)),
)

/** 主题偏好 cookie（light / dark；其它值视为跟随系统） */
export const THEME_COOKIE = "wellspring_web_theme"

/** 主题 cookie 取值 → 注入模板的主题属性值 */
export function normalizeTheme(value: string | undefined): "" | "light" | "dark" {
    return value === "light" || value === "dark" ? value : ""
}

/** 替换 index.html 中的 {{theme}} 占位 */
export function applyThemeTemplate(html: string, theme: string): string {
    const value = normalizeTheme(theme)
    return html.includes("{{theme}}") ? html.split("{{theme}}").join(value) : html
}

/** 模板缺失时给开发者的提示页 */
export const MISSING_WWW_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Wellspring Web</title>
</head>
<body>
<h1>前端产物缺失</h1>
<p>运行 npm run build:ui 生成 www/ 后刷新</p>
</body>
</html>
`

type NodeFsPromises = typeof import("node:fs/promises")

interface CachedBytes {
    readonly size: number
    readonly mtimeMs: number
    readonly bytes: Uint8Array
}

function trimTrailingSeparators(path: string): string {
    const trimmed = path.replace(/[\\/]+$/, "")
    return trimmed === "" ? path : trimmed
}

/** node:fs/promises；首次读取时经 getBuiltinModule 加载 */
function loadNodeFs(): NodeFsPromises {
    const fs = process.getBuiltinModule("node:fs/promises")
    if (fs === undefined) {
        throw new Error("无法加载 node:fs/promises")
    }
    return fs
}

/**
 * 插件目录静态资源读取（绝对路径）
 *
 * 文件按 path + size + mtime 缓存字节：www 是构建产物，正常不会被改写
 */
export function createPluginStaticFs(): StaticFileSystem {
    let fs: NodeFsPromises | null = null
    const cache = new Map<string, CachedBytes>()
    const nodeFs = (): NodeFsPromises => {
        fs ??= loadNodeFs()
        return fs
    }
    return {
        async stat(path: string): Promise<StaticFileStat | null> {
            try {
                const info = await nodeFs().stat(path)
                const type: StaticFileStat["type"] = info.isFile()
                    ? "file"
                    : info.isDirectory()
                      ? "directory"
                      : "other"
                return { type, size: info.size, mtimeMs: info.mtimeMs }
            } catch {
                return null
            }
        },
        async readBytes(path: string): Promise<Uint8Array | null> {
            try {
                const info = await nodeFs().stat(path)
                const cached = cache.get(path)
                if (cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
                    return cached.bytes
                }
                const bytes = new Uint8Array(await nodeFs().readFile(path))
                cache.set(path, { size: info.size, mtimeMs: info.mtimeMs, bytes })
                return bytes
            } catch {
                return null
            }
        },
    }
}

/** 写入型文件系统：测试 helper 与后续迁移脚本共用 */
export interface WwwFileSystem {
    stat(path: string): Promise<{ readonly type: "file" | "directory" | "other" } | null>
    mkdir(path: string): Promise<void>
    writeText(path: string, text: string): Promise<void>
}
