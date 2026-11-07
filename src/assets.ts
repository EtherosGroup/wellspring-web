/*
 * 默认 www 资源
 *
 * 插件数据目录没有 www/ 时写入一份骨架；已存在的文件不覆盖，用户可以直接改 www 下的文件
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
<link rel="stylesheet" href="/style.css">
</head>
<body>
<main>
<h1>Wellspring Web</h1>
<p class="hint">界面骨架：替换插件数据目录 www/ 下的文件即可</p>
</main>
<script src="/app.js"></script>
</body>
</html>
`,
    },
    {
        name: "style.css",
        content: `:root { color-scheme: light dark; }
* { box-sizing: border-box; }
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
main { text-align: center; }
h1 { margin: 0 0 8px; font-size: 24px; font-weight: 600; }
p.hint { margin: 0; font-size: 14px; color: #71717a; }
@media (prefers-color-scheme: dark) {
    body { background: #09090b; color: #fafafa; }
    p.hint { color: #a1a1aa; }
}
`,
    },
    {
        name: "app.js",
        content: `document.documentElement.dataset.wellspringWeb = "ready"
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
