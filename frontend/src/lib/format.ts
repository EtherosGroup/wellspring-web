/*
 * 展示格式化：时间、时长、token、权限、工具行摘要
 */

const TOOL_ICON_RULES: Array<{ pattern: RegExp; icon: string }> = [
    { pattern: /bash|shell|exec|terminal|command|run/i, icon: "terminal" },
    { pattern: /glob|grep|find|search|rg/i, icon: "search" },
    { pattern: /fetch|http|browser|web/i, icon: "external" },
    { pattern: /read|open|file/i, icon: "file" },
    { pattern: /write|edit|patch|apply/i, icon: "pencil" },
    { pattern: /ask|question|message/i, icon: "message" },
    { pattern: /todo|plan|task|goal/i, icon: "layers" },
    { pattern: /ls|list|tree|dir|folder/i, icon: "folder" },
]

const TOOL_SUMMARY_RULES: Array<{ pattern: RegExp; keys: string[] }> = [
    { pattern: /bash|shell|exec|terminal|command|run/i, keys: ["command", "cmd", "script"] },
    { pattern: /glob|grep|find|search|rg/i, keys: ["pattern", "query", "glob"] },
    { pattern: /fetch|http|browser|web/i, keys: ["url", "query"] },
    { pattern: /read|write|edit|patch|open|file/i, keys: ["file_path", "path", "filePath", "target", "target_file"] },
    { pattern: /ask|question/i, keys: ["question"] },
    { pattern: /todo|plan|task|goal/i, keys: ["subject", "description", "title", "content"] },
    { pattern: /ls|list|tree|dir|folder/i, keys: ["path", "dir"] },
]

/** 图标 sprite 名 */
export function toolIconName(name: string): string {
    for (const rule of TOOL_ICON_RULES) {
        if (rule.pattern.test(name)) {
            return rule.icon
        }
    }
    return "wrench"
}

/** 毫秒时长：320ms / 1.2s / 2m 5s */
export function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) {
        return "—"
    }
    if (ms < 1000) {
        return `${Math.max(1, Math.round(ms))}ms`
    }
    if (ms < 60_000) {
        return `${(ms / 1000).toFixed(1)}s`
    }
    const minutes = Math.floor(ms / 60_000)
    const seconds = Math.round((ms % 60_000) / 1000)
    return `${minutes}m ${seconds}s`
}

/** 思考用时：3 秒 */
export function formatReasoningTime(ms: number): string {
    const seconds = Math.max(1, Math.round(ms / 1000))
    return `${seconds} 秒`
}

/** 时间 HH:mm */
export function formatClock(at: number): string {
    const date = new Date(at)
    if (Number.isNaN(date.getTime())) {
        return "—"
    }
    const hours = String(date.getHours()).padStart(2, "0")
    const minutes = String(date.getMinutes()).padStart(2, "0")
    return `${hours}:${minutes}`
}

/** token 数：834 / 1.2k / 3.4m */
export function formatTokens(value: number | null | undefined): string {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return "—"
    }
    if (value >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(1)}m`
    }
    if (value >= 1_000) {
        return `${(value / 1_000).toFixed(1)}k`
    }
    return String(value)
}

/** 权限名 */
export function formatPermission(permission: string | null | undefined): string {
    switch (permission) {
        case "read-only":
            return "只读"
        case "workspace-write":
            return "工作区写入"
        case "danger-full-access":
            return "完全访问"
        default:
            return "未设置"
    }
}

/** 工具参数单行摘要：按工具名取关键字段 */
export function summarizeToolArguments(name: string, raw: string | undefined): string {
    const source = raw?.trim() ?? ""
    if (source === "") {
        return ""
    }
    let parsed: unknown = null
    try {
        parsed = JSON.parse(source)
    } catch {
        parsed = null
    }
    if (parsed === null || typeof parsed !== "object") {
        return collapse(source)
    }
    const record = parsed as Record<string, unknown>
    for (const rule of TOOL_SUMMARY_RULES) {
        if (!rule.pattern.test(name)) {
            continue
        }
        for (const key of rule.keys) {
            const text = primitiveText(record[key])
            if (text !== "") {
                return collapse(text)
            }
        }
    }
    for (const value of Object.values(record)) {
        const text = primitiveText(value)
        if (text !== "") {
            return collapse(text)
        }
    }
    return collapse(source)
}

function primitiveText(value: unknown): string {
    if (typeof value === "string") {
        return value
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value)
    }
    if (Array.isArray(value)) {
        const parts = value.map(primitiveText).filter((text) => text !== "")
        if (parts.length > 0) {
            return parts.join(", ")
        }
    }
    return ""
}

function collapse(text: string): string {
    return text.replace(/\s+/g, " ").trim().slice(0, 240)
}

/** 缩进 JSON；非 JSON 原样返回 */
export function prettyJson(raw: string | undefined): string {
    const source = raw?.trim() ?? ""
    if (source === "") {
        return ""
    }
    try {
        const parsed = JSON.parse(source) as unknown
        if (parsed === null || typeof parsed !== "object") {
            return source
        }
        return JSON.stringify(parsed, null, 2)
    } catch {
        return source
    }
}
