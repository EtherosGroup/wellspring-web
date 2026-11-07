import type { WwwFileSystem } from "../../src/assets.ts"
import type { StaticFileStat, StaticFileSystem } from "../../src/static.ts"

interface MemoryFile {
    readonly bytes: Uint8Array
    readonly mtimeMs: number
}

/** 测试用内存文件系统 */
export class MemoryFs implements StaticFileSystem, WwwFileSystem {
    readonly files = new Map<string, MemoryFile>()
    readonly dirs = new Set<string>()

    constructor(entries: Record<string, string | Uint8Array> = {}) {
        for (const [path, content] of Object.entries(entries)) {
            this.addFile(path, content)
        }
    }

    addFile(path: string, content: string | Uint8Array, mtimeMs = 1_000): void {
        const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content
        this.files.set(path, { bytes, mtimeMs })
        this.ensureParents(path)
    }

    async stat(path: string): Promise<StaticFileStat | null> {
        const file = this.files.get(path)
        if (file !== undefined) {
            return { type: "file", size: file.bytes.length, mtimeMs: file.mtimeMs }
        }
        if (this.dirs.has(path)) {
            return { type: "directory", size: 0, mtimeMs: 0 }
        }
        return null
    }

    async readBytes(path: string): Promise<Uint8Array | null> {
        return this.files.get(path)?.bytes ?? null
    }

    async mkdir(path: string): Promise<void> {
        this.dirs.add(path)
        this.ensureParents(path)
    }

    async writeText(path: string, text: string): Promise<void> {
        this.addFile(path, text)
    }

    async text(path: string): Promise<string | null> {
        const bytes = await this.readBytes(path)
        return bytes === null ? null : Buffer.from(bytes).toString("utf8")
    }

    private ensureParents(path: string): void {
        const parts = path.split("/")
        for (let index = 1; index < parts.length; index += 1) {
            this.dirs.add(parts.slice(0, index).join("/"))
        }
    }
}
