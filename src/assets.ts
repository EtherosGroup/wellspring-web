/*
 * 占位页
 *
 * 插件数据目录没有 www/ 时写入一份占位页；已存在的文件不覆盖，网页文件由使用者自己放进来
 */

export interface WwwFileSystem {
    stat(path: string): Promise<{ readonly type: "file" | "directory" | "other" } | null>
    mkdir(path: string): Promise<void>
    writeText(path: string, text: string): Promise<void>
}

export interface SeedFile {
    readonly name: string
    readonly content: string
}

export const SEED_FILES: readonly SeedFile[] = [
    {
        name: "index.html",
        content: `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wellspring Web</title>
<style>
:root { color-scheme: light dark; }
body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #f4f4f5;
    color: #18181b;
    font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans CJK SC", sans-serif;
}
main { max-width: 640px; padding: 32px; }
h1 { margin: 0 0 12px; font-size: 22px; font-weight: 600; }
p { margin: 0 0 8px; font-size: 14px; line-height: 1.7; color: #52525b; }
code { padding: 1px 5px; border-radius: 4px; background: #e4e4e7; font-family: ui-monospace, Consolas, monospace; }
@media (prefers-color-scheme: dark) {
    body { background: #09090b; color: #fafafa; }
    p { color: #a1a1aa; }
    code { background: #27272a; }
}
</style>
</head>
<body>
<main>
<h1>Wellspring Web</h1>
<p>占位页。把网页文件放进插件数据目录的 <code>www/</code> 即可，修改后刷新生效，不需要重启。</p>
<p>经网关访问时页面在 <code>/web/</code> 前缀下；需要接口时在 index.ts 的 HTTP handler 里扩展。</p>
</main>
</body>
</html>
`,
    },
]

export interface EnsureWwwResult {
    readonly dirCreated: boolean
    readonly created: readonly string[]
    readonly skipped: readonly string[]
}

/** 补齐 www 目录与缺失的默认文件 */
export async function ensureWww(fs: WwwFileSystem, dir: string): Promise<EnsureWwwResult> {
    let dirCreated = false
    const existing = await fs.stat(dir)
    if (existing === null) {
        await fs.mkdir(dir)
        dirCreated = true
    } else if (existing.type !== "directory") {
        throw new Error(`www 路径不是目录：${dir}`)
    }
    const created: string[] = []
    const skipped: string[] = []
    for (const file of SEED_FILES) {
        const path = `${dir}/${file.name}`
        const stat = await fs.stat(path)
        if (stat !== null) {
            skipped.push(file.name)
            continue
        }
        await fs.writeText(path, file.content)
        created.push(file.name)
    }
    return { dirCreated, created, skipped }
}
