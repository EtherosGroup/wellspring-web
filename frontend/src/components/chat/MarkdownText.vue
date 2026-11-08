<script setup lang="ts">
/*
 * Markdown 正文
 *
 * marked + DOMPurify 产物走 v-html；流式更新按 200ms 节流，收尾立即刷新
 * 代码块复制用事件委托，按钮由渲染器生成
 */

import { onBeforeUnmount, onMounted, ref, watch } from "vue"

import { COPY_ATTR, copyText, createMarkdownStream } from "../../lib/markdown"

const props = withDefaults(defineProps<{ text: string; streaming?: boolean }>(), { streaming: false })

const root = ref<HTMLElement | null>(null)
const html = ref("")

const stream = createMarkdownStream((next) => {
    html.value = next
})

onMounted(() => {
    stream.update(props.text, props.streaming)
})

watch(
    () => [props.text, props.streaming] as const,
    ([text, streaming]) => {
        stream.update(text, streaming)
    },
)

onBeforeUnmount(() => {
    stream.dispose()
})

function onClick(event: MouseEvent): void {
    const target = event.target
    if (!(target instanceof Element) || root.value === null) {
        return
    }
    const button = target.closest(`[${COPY_ATTR}]`)
    if (button === null || !root.value.contains(button) || !(button instanceof HTMLButtonElement)) {
        return
    }
    const container = button.closest(".md-code")
    const code = container?.querySelector("code")
    if (code === null || code === undefined) {
        return
    }
    void copyText(code.textContent ?? "").then((ok) => {
        if (!ok) {
            return
        }
        button.textContent = "已复制"
        window.setTimeout(() => {
            button.textContent = "复制"
        }, 1600)
    })
}
</script>

<template>
    <div ref="root" class="md" @click="onClick" v-html="html" />
</template>

<!-- Markdown 排版是 v-html 产物，样式必须非 scoped，统一挂在 .md 下 -->
<style>
.md {
    color: var(--ink);
    font-size: var(--text-md);
    line-height: 1.75;
    overflow-wrap: anywhere;
}

.md > :first-child {
    margin-top: 0;
}

.md > :last-child {
    margin-bottom: 0;
}

.md p {
    margin: 0 0 0.85em;
}

.md h1,
.md h2,
.md h3,
.md h4,
.md h5,
.md h6 {
    margin: 1.5em 0 0.55em;
    color: var(--ink);
    font-weight: 600;
    line-height: 1.35;
    letter-spacing: 0.01em;
}

.md h1 {
    font-family: var(--font-serif);
    font-size: 1.35em;
    font-weight: 500;
}

.md h2 {
    font-size: 1.16em;
}

.md h3,
.md h4,
.md h5,
.md h6 {
    font-size: 1em;
}

.md strong {
    font-weight: 650;
    color: var(--ink);
}

.md em {
    font-style: italic;
}

.md del {
    color: var(--faint);
}

.md a {
    color: var(--accent);
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--accent) 35%, transparent);
    text-underline-offset: 2px;
    transition: color var(--dur-fast) var(--ease);
}

.md a:hover {
    color: var(--accent-strong);
    text-decoration-color: currentColor;
}

.md ul,
.md ol {
    margin: 0 0 0.85em;
    padding-left: 1.5em;
}

.md li {
    margin: 0.25em 0;
}

.md li::marker {
    color: var(--faint);
}

.md li > p {
    margin: 0.2em 0;
}

/* 任务列表 */

.md li:has(> input[type="checkbox"]) {
    list-style: none;
    margin-left: -1.25em;
    padding-left: 1.25em;
    position: relative;
}

.md li > input[type="checkbox"] {
    appearance: none;
    position: absolute;
    left: 0;
    top: 0.48em;
    width: 14px;
    height: 14px;
    margin: 0;
    border: 1px solid var(--hairline-strong);
    border-radius: 4px;
    background: var(--surface);
    pointer-events: none;
}

.md li > input[type="checkbox"]:checked {
    border-color: var(--accent);
    background: var(--accent);
}

.md blockquote {
    margin: 1em 0;
    padding: 0.1em 0 0.1em 0.95em;
    border-left: 2px solid var(--hairline-strong);
    color: var(--ink-2);
}

.md blockquote p:last-child {
    margin-bottom: 0;
}

.md hr {
    margin: 1.5em 0;
    border: 0;
    border-top: 1px solid var(--hairline);
}

.md code {
    font-family: var(--font-mono);
    font-size: 0.86em;
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    border-radius: 5px;
    padding: 0.08em 0.35em;
    color: var(--ink-2);
}

.md pre code {
    background: none;
    border: 0;
    border-radius: 0;
    padding: 0;
    font-size: inherit;
    color: inherit;
}

/* 表格 */

.md table {
    display: block;
    width: max-content;
    max-width: 100%;
    margin: 1em 0;
    border-collapse: collapse;
    overflow-x: auto;
    font-size: 0.92em;
}

.md th,
.md td {
    border: 1px solid var(--hairline);
    padding: 6px 10px;
    text-align: left;
    vertical-align: top;
}

.md th {
    background: var(--surface-2);
    font-weight: 600;
    white-space: nowrap;
}

.md img {
    max-width: 100%;
    height: auto;
    margin: 0.6em 0;
    border-radius: var(--radius-sm);
    border: 1px solid var(--hairline);
}

/* 代码块：语言标签 + 复制按钮 */

.md .md-code {
    margin: 1em 0;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    overflow: hidden;
}

.md .md-code__bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: 4px 6px 4px 12px;
    border-bottom: 1px solid var(--hairline);
    background: var(--surface-3);
}

.md .md-code__lang {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--faint);
}

.md .md-code__copy {
    min-height: 24px;
    padding: 0 8px;
    border-radius: var(--radius-full);
    border: 1px solid transparent;
    background: transparent;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: 0.02em;
    transition:
        background var(--dur-fast) var(--ease),
        color var(--dur-fast) var(--ease);
}

.md .md-code__copy:hover {
    background: var(--surface);
    color: var(--accent);
}

.md .md-code__pre {
    margin: 0;
    padding: 12px 14px;
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: 0.78125rem;
    line-height: 1.65;
    tab-size: 4;
    color: var(--ink-2);
}

@media (max-width: 640px) {
    .md {
        font-size: var(--text-base);
    }

    .md .md-code__pre {
        padding: 10px 12px;
        font-size: 0.75rem;
    }
}
</style>
