/*
 * Markdown 渲染
 *
 * marked 解析 + DOMPurify 净化，产物直接给 v-html
 * 代码块：.md-code[data-lang] > .md-code__bar（语言标签 + [data-copy] 按钮）+ pre > code
 * 链接：仅 http(s) / mailto，统一 target=_blank rel="noopener noreferrer"
 * 流式：createMarkdownStream 按 MARKDOWN_RENDER_INTERVAL 节流，非流式状态立即刷新
 */

import DOMPurify, { type Config } from "dompurify"
import { Marked, Renderer, type Tokens } from "marked"

/** 流式渲染间隔（毫秒） */
export const MARKDOWN_RENDER_INTERVAL = 200
/** 复制按钮标记属性 */
export const COPY_ATTR = "data-copy"

const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"])

/* ------------------------------ 转义与判定 ------------------------------ */

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

/** 链接协议白名单判定 */
export function isAllowedLink(url: string): boolean {
    const value = url.trim()
    if (value === "") {
        return false
    }
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value)
    if (match === null) {
        return false
    }
    const protocol = `${(match[1] ?? "").toLowerCase()}:`
    return ALLOWED_LINK_PROTOCOLS.has(protocol)
}

/** 代码块语言标签：取首个词，过滤非法字符 */
function normalizeLanguage(lang: string | undefined): string {
    if (lang === undefined) {
        return ""
    }
    const first = lang.trim().split(/\s+/)[0] ?? ""
    return first.replace(/[^A-Za-z0-9_+#.-]/g, "").slice(0, 24)
}

/* ------------------------------ 渲染器 ------------------------------ */

const renderer = {
    code(this: Renderer, { text, lang }: Tokens.Code): string {
        const language = normalizeLanguage(lang)
        const label = language === "" ? "text" : language
        const source = escapeHtml(text.replace(/\n$/, ""))
        return (
            `<div class="md-code" data-lang="${escapeHtml(language)}">` +
            `<div class="md-code__bar"><span class="md-code__lang">${escapeHtml(label)}</span>` +
            `<button type="button" class="md-code__copy" ${COPY_ATTR}="1" aria-label="复制代码">复制</button>` +
            `</div>` +
            `<pre class="md-code__pre"><code class="md-code__code">${source}</code></pre>` +
            `</div>`
        )
    },
    link(this: Renderer, { href, title, text, tokens, autolink }: Tokens.Link): string {
        const label = autolink === true ? escapeHtml(text) : this.parser.parseInline(tokens)
        const url = href.trim()
        if (!isAllowedLink(url)) {
            return label
        }
        const titleAttr =
            title === null || title === undefined || title === "" ? "" : ` title="${escapeHtml(title)}"`
        return (
            `<a href="${escapeHtml(url)}"${titleAttr} target="_blank" rel="noopener noreferrer">` +
            `${label}</a>`
        )
    },
}

const engine = new Marked({
    gfm: true,
    breaks: true,
    renderer,
})

/* ------------------------------ 净化 ------------------------------ */

/* 外链属性由 hook 统一补，避免模型输出里带 target/rel 干扰 */
DOMPurify.addHook("afterSanitizeAttributes", (node: Element): void => {
    if (node.tagName !== "A") {
        return
    }
    const href = node.getAttribute("href")
    if (href === null || !isAllowedLink(href)) {
        node.removeAttribute("href")
        node.removeAttribute("target")
        node.removeAttribute("rel")
        return
    }
    node.setAttribute("target", "_blank")
    node.setAttribute("rel", "noopener noreferrer")
})

const SANITIZE_CONFIG: Config = {
    /* 任务列表复选框与代码块标记属性 */
    ADD_ATTR: ["checked", "disabled", "type", "start", "target", "rel"],
    /* 表单与内嵌框架不进正文 */
    FORBID_TAGS: ["form", "textarea", "select", "option", "iframe", "object", "embed", "base", "meta", "link", "style"],
    FORBID_ATTR: ["style", "srcdoc", "formaction"],
}

/** 净化 marked 产物 */
export function sanitizeHtml(html: string): string {
    return DOMPurify.sanitize(html, SANITIZE_CONFIG)
}

/** Markdown 转净化后的 HTML */
export function renderMarkdown(markdown: string): string {
    if (markdown.trim() === "") {
        return ""
    }
    try {
        return sanitizeHtml(engine.parse(markdown, { async: false }))
    } catch {
        return `<p>${escapeHtml(markdown)}</p>`
    }
}

/* ------------------------------ 流式节流 ------------------------------ */

export interface MarkdownStream {
    /** 流式时按间隔节流，非流式时立即渲染 */
    update: (markdown: string, streaming: boolean) => void
    /** 立即渲染待处理的文本 */
    flush: () => void
    dispose: () => void
}

/**
 * 流式渲染节流器：第一次渲染立即执行，之后按 interval 合并更新
 * 收尾调用 update(text, false) 或 flush() 立即刷新
 */
export function createMarkdownStream(
    render: (html: string) => void,
    interval = MARKDOWN_RENDER_INTERVAL,
): MarkdownStream {
    let timer: ReturnType<typeof setTimeout> | null = null
    let pending: string | null = null
    let lastRendered: string | null = null
    let disposed = false

    const clearTimer = (): void => {
        if (timer !== null) {
            clearTimeout(timer)
            timer = null
        }
    }

    const emit = (markdown: string): void => {
        if (disposed || markdown === lastRendered) {
            return
        }
        lastRendered = markdown
        render(renderMarkdown(markdown))
    }

    return {
        update(markdown: string, streaming: boolean): void {
            if (!streaming) {
                clearTimer()
                pending = null
                emit(markdown)
                return
            }
            if (lastRendered === null) {
                emit(markdown)
                return
            }
            pending = markdown
            if (timer !== null) {
                return
            }
            timer = setTimeout(() => {
                timer = null
                const next = pending
                pending = null
                if (next !== null) {
                    emit(next)
                }
            }, interval)
        },
        flush(): void {
            clearTimer()
            const next = pending
            pending = null
            if (next !== null) {
                emit(next)
            }
        },
        dispose(): void {
            disposed = true
            clearTimer()
            pending = null
        },
    }
}

/* ------------------------------ 代码复制 ------------------------------ */

/** 复制文本；Clipboard API 不可用时回退 execCommand */
export async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard !== undefined && window.isSecureContext) {
            await navigator.clipboard.writeText(text)
            return true
        }
    } catch {
        /* 回退到 execCommand */
    }
    const area = document.createElement("textarea")
    area.value = text
    area.setAttribute("readonly", "")
    area.style.position = "fixed"
    area.style.top = "0"
    area.style.opacity = "0"
    document.body.appendChild(area)
    area.select()
    let copied = false
    try {
        copied = document.execCommand("copy")
    } catch {
        copied = false
    }
    area.remove()
    return copied
}
