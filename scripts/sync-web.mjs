/*
 * 把 frontend/dist 同步到插件数据目录的 www/
 *
 * 目标：<dataDir>/plugin-data/wellspring-web/www
 * dataDir 取 $WELLSPRING_DATA_DIR；便携模式取 $WELLSPRING_HOME/data；默认 ~/.local/share/wellspring
 *
 * 默认覆盖同名文件；--clean 先清空目标目录（构建产物带 hash、旧文件不会自动消失时推荐）
 */

import { cp, mkdir, readdir, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const repoRoot = join(import.meta.dirname, "..")
const source = join(repoRoot, "frontend", "dist")

const exists = async (path) => {
    try {
        await stat(path)
        return true
    } catch {
        return false
    }
}

if (!(await exists(join(source, "index.html")))) {
    console.error("未找到 frontend/dist/index.html，先运行 pnpm build:ui")
    process.exit(1)
}

const dataDir =
    process.env.WELLSPRING_DATA_DIR ??
    (process.env.WELLSPRING_HOME !== undefined
        ? join(process.env.WELLSPRING_HOME, "data")
        : join(homedir(), ".local", "share", "wellspring"))
const target = join(dataDir, "plugin-data", "wellspring-web", "www")

if (process.argv.includes("--clean")) {
    await rm(target, { recursive: true, force: true })
    console.log(`已清空 ${target}`)
}
await mkdir(target, { recursive: true })
await cp(source, target, { recursive: true, force: true })

const countFiles = async (dir) => {
    let total = 0
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        total += entry.isDirectory() ? await countFiles(join(dir, entry.name)) : 1
    }
    return total
}

console.log(`已同步前端产物：${source} → ${target}（${await countFiles(target)} 个文件）`)
console.log("刷新浏览器即可（经网关访问时用 /web/ 前缀并保留尾斜杠）。")
