<script setup lang="ts">
/*
 * 对话主区
 *
 * 消息列表 + 底部自动跟随（用户上翻时不拽回）+ 空状态 + 流式状态条
 * 数据与动作全部来自 store；提问/审批/重试在这里转成 actions 调用
 */

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"

import Icon from "../Icon.vue"
import MessageItem from "./MessageItem.vue"
import { actions, store } from "../../store"
import type { ChatMessage } from "../../types"

/* 距底部小于该值时视为跟随 */
const STICK_THRESHOLD = 64

const scroller = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const stick = ref(true)
const latestVisible = ref(false)
const stopPending = ref(false)

const messages = computed<ChatMessage[]>(() => store.conversation?.messages ?? [])
const ready = computed(() => store.ready)
const fatalError = computed(() => store.error)
const streaming = computed(() => store.streaming)
const isEmpty = computed(() => ready.value && fatalError.value === null && messages.value.length === 0)

const lastAssistant = computed<ChatMessage | null>(() => {
    for (let index = messages.value.length - 1; index >= 0; index -= 1) {
        const message = messages.value[index]
        if (message !== undefined && message.role === "assistant") {
            return message
        }
    }
    return null
})

/* ------------------------------ 空状态 ------------------------------ */

interface Suggestion {
    title: string
    caption: string
    icon: string
    draft: string
}

const suggestions: Suggestion[] = [
    {
        title: "梳理一个想法",
        caption: "列出已知条件与待定问题",
        icon: "sparkles",
        draft: "梳理一下这个想法：\n\n",
    },
    {
        title: "读一个目录",
        caption: "说明目录结构与模块职责",
        icon: "folder",
        draft: "读一下当前工作区的目录结构，说明各模块职责：\n\n@",
    },
    {
        title: "写一段代码",
        caption: "给出实现、边界与测试",
        icon: "terminal",
        draft: "写一段代码实现：\n\n",
    },
]

const contextLabel = computed(() => {
    const conversation = store.conversation
    if (conversation === null) {
        return ""
    }
    return conversation.cwd ?? "宿主当前目录"
})

function useSuggestion(suggestion: Suggestion): void {
    actions.setDraft(suggestion.draft)
    void nextTick(() => {
        window.dispatchEvent(new CustomEvent("wellspring:focus-composer"))
        const input = document.querySelector<HTMLElement>("[data-composer-input]")
        input?.focus()
    })
}

/* ------------------------------ 状态条 ------------------------------ */

type StatusKind = "live" | "error" | "warn" | "muted"

interface StatusBar {
    kind: StatusKind
    icon: string
    label: string
    detail: string
    retry: boolean
    stop: boolean
}

function liveLabel(message: ChatMessage): string {
    const step = message.steps ?? 0
    const prefix = step > 0 ? `第 ${step} 步` : ""
    const last = message.blocks[message.blocks.length - 1]
    let phase = "准备中"
    if (last !== undefined) {
        if (last.type === "reasoning" && last.endedAt === null) {
            phase = "思考中"
        } else if (last.type === "tool" && last.status === "running" && last.endedAt === null) {
            phase = `工具执行中 · ${last.name}`
        } else if (last.type === "ask" && last.answer === null) {
            phase = "等待回答"
        } else if (last.type === "approval" && last.approved === null) {
            phase = "等待审批"
        } else if (message.blocks.some((block) => block.type === "text")) {
            phase = "正在回复"
        }
    }
    return prefix === "" ? phase : `${prefix} · ${phase}`
}

const statusBar = computed<StatusBar | null>(() => {
    const assistant = lastAssistant.value
    if (streaming.value && assistant !== null && assistant.status === "streaming") {
        return { kind: "live", icon: "spring", label: liveLabel(assistant), detail: "", retry: false, stop: true }
    }
    if (assistant === null) {
        return null
    }
    if (assistant.status === "error") {
        return {
            kind: "error",
            icon: "alert-circle",
            label: "本轮失败",
            detail: "",
            retry: true,
            stop: false,
        }
    }
    if (assistant.status === "interrupted") {
        return {
            kind: "warn",
            icon: "alert",
            label: "连接中断",
            detail: "",
            retry: true,
            stop: false,
        }
    }
    if (assistant.status === "stopped") {
        return { kind: "muted", icon: "stop", label: "已停止", detail: "", retry: true, stop: false }
    }
    return null
})

/* ------------------------------ 滚动跟随 ------------------------------ */

function distanceToBottom(element: HTMLElement): number {
    return element.scrollHeight - element.scrollTop - element.clientHeight
}

function onScroll(): void {
    const element = scroller.value
    if (element === null) {
        return
    }
    const top = element.scrollTop
    const near = distanceToBottom(element) <= STICK_THRESHOLD
    /* 只有向上滚动才解除跟随，内容增高触发的 scroll 位置变化不算 */
    if (near) {
        stick.value = true
    } else if (top < lastScrollTop - 2) {
        stick.value = false
    }
    lastScrollTop = top
    latestVisible.value = !near
}

function scrollToBottom(behavior: ScrollBehavior = "auto"): void {
    const element = scroller.value
    if (element === null) {
        return
    }
    element.scrollTo({ top: element.scrollHeight, behavior })
}

function follow(): void {
    if (stick.value) {
        scrollToBottom()
    }
}

function reducedMotion(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

function jumpToLatest(): void {
    stick.value = true
    latestVisible.value = false
    scrollToBottom(reducedMotion() ? "auto" : "smooth")
}

let contentObserver: ResizeObserver | null = null
let viewportObserver: ResizeObserver | null = null
let lastScrollTop = 0

onMounted(() => {
    if (content.value !== null) {
        contentObserver = new ResizeObserver(() => {
            follow()
        })
        contentObserver.observe(content.value)
    }
    if (scroller.value !== null) {
        viewportObserver = new ResizeObserver(() => {
            follow()
        })
        viewportObserver.observe(scroller.value)
        lastScrollTop = scroller.value.scrollTop
    }
    scrollToBottom()
})

onBeforeUnmount(() => {
    contentObserver?.disconnect()
    viewportObserver?.disconnect()
    contentObserver = null
    viewportObserver = null
})

watch(
    () => messages.value.length,
    async (next, previous) => {
        if (next <= previous) {
            return
        }
        stick.value = true
        latestVisible.value = false
        await nextTick()
        scrollToBottom()
    },
)

watch(
    () => store.activeId,
    async () => {
        stick.value = true
        latestVisible.value = false
        await nextTick()
        scrollToBottom()
    },
)

/* ------------------------------ 动作 ------------------------------ */

async function onStop(): Promise<void> {
    if (stopPending.value) {
        return
    }
    stopPending.value = true
    try {
        await actions.stop()
    } finally {
        window.setTimeout(() => {
            stopPending.value = false
        }, 1500)
    }
}

async function onRetry(): Promise<void> {
    await actions.retry()
}

async function onBootstrapRetry(): Promise<void> {
    await actions.bootstrap()
}

function onMessageAnswer(askId: string, answer: string): void {
    void actions.answerAsk(askId, answer)
}

function onMessageSkip(askId: string): void {
    void actions.answerAsk(askId, "")
}

function onMessageDecide(approvalId: string, approved: boolean): void {
    void actions.answerApproval(approvalId, approved)
}

function onMessageRetry(): void {
    void actions.retry()
}
</script>

<template>
    <section class="thread" aria-label="对话">
        <div class="thread__viewport">
            <div ref="scroller" class="thread__scroll scroll" @scroll="onScroll">
                <div ref="content" class="thread__inner">
                    <!-- 初始加载 -->
                    <div v-if="!ready" class="thread__skeleton" aria-busy="true" aria-label="加载会话">
                        <div class="skeleton thread__skeleton-line" />
                        <div class="skeleton thread__skeleton-line" />
                        <div class="skeleton thread__skeleton-line" />
                        <div class="skeleton thread__skeleton-line" />
                    </div>

                    <!-- 首屏错误 -->
                    <div v-else-if="fatalError !== null" class="thread__fatal">
                        <Icon class="thread__fatal-icon" name="alert-circle" :size="22" />
                        <p class="thread__fatal-title">载入失败</p>
                        <p class="thread__fatal-text">{{ fatalError }}</p>
                        <button type="button" class="btn" @click="onBootstrapRetry">重试</button>
                    </div>

                    <!-- 空状态 -->
                    <div v-else-if="isEmpty && !streaming" class="thread__empty">
                        <p v-if="contextLabel !== ''" class="thread__eyebrow">{{ contextLabel }}</p>
                        <h1 class="thread__title">从哪里开始？</h1>
                        <p class="thread__subtitle">对话按会话保存，可随时继续</p>
                        <div class="thread__suggestions">
                            <button
                                v-for="suggestion in suggestions"
                                :key="suggestion.title"
                                type="button"
                                class="thread__suggestion"
                                @click="useSuggestion(suggestion)"
                            >
                                <span class="thread__suggestion-icon">
                                    <Icon :name="suggestion.icon" :size="17" />
                                </span>
                                <span class="thread__suggestion-body">
                                    <span class="thread__suggestion-title">{{ suggestion.title }}</span>
                                    <span class="thread__suggestion-caption">{{ suggestion.caption }}</span>
                                </span>
                                <Icon class="thread__suggestion-arrow" name="arrow-right" :size="15" />
                            </button>
                        </div>
                    </div>

                    <!-- 消息列表 -->
                    <div v-else class="thread__messages">
                        <MessageItem
                            v-for="message in messages"
                            :key="message.id"
                            :message="message"
                            :streaming="streaming"
                            @retry="onMessageRetry"
                            @answer="onMessageAnswer"
                            @skip="onMessageSkip"
                            @decide="onMessageDecide"
                        />
                    </div>
                </div>
            </div>

            <button
                v-if="latestVisible"
                type="button"
                class="thread__latest"
                aria-label="滚动到最新消息"
                @click="jumpToLatest"
            >
                <Icon name="chevron-down" :size="15" />
                <span class="thread__latest-text">最新</span>
            </button>
        </div>

        <!-- 流式状态条 -->
        <div
            v-if="statusBar !== null"
            class="thread__bar"
            :class="`thread__bar--${statusBar.kind}`"
            role="status"
            aria-live="polite"
        >
            <template v-if="statusBar.kind === 'live'">
                <span class="spinner thread__bar-spinner" aria-hidden="true" />
                <span class="thread__bar-text">{{ statusBar.label }}</span>
                <button
                    type="button"
                    class="thread__bar-btn"
                    :disabled="stopPending"
                    aria-label="停止本轮回复"
                    @click="onStop"
                >
                    <Icon name="stop" :size="11" />
                    <span>{{ stopPending ? "停止中" : "停止" }}</span>
                </button>
            </template>
            <template v-else>
                <Icon class="thread__bar-icon" :name="statusBar.icon" :size="14" />
                <span class="thread__bar-text">{{ statusBar.label }}</span>
                <span v-if="statusBar.detail !== ''" class="thread__bar-detail" :title="statusBar.detail">
                    {{ statusBar.detail }}
                </span>
                <button v-if="statusBar.retry" type="button" class="thread__bar-btn" @click="onRetry">
                    <Icon name="refresh" :size="12" />
                    <span>重试</span>
                </button>
            </template>
        </div>
    </section>
</template>

<style scoped>
.thread {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    background: var(--bg);
}

.thread__viewport {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
}

.thread__scroll {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
}

.thread__inner {
    display: flex;
    flex-direction: column;
    gap: 30px;
    width: 100%;
    max-width: var(--content-width);
    min-height: 100%;
    margin: 0 auto;
    padding: 30px 28px 20px;
}

/* ------------------------------ 空状态 ------------------------------ */

.thread__empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    flex: 1;
    padding: 0 0 8vh;
}

.thread__eyebrow {
    margin-bottom: 14px;
    color: var(--faint);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    letter-spacing: 0.02em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
}

.thread__title {
    margin: 0 0 8px;
    color: var(--ink);
    font-family: var(--font-serif);
    font-size: var(--text-3xl);
    font-weight: 400;
    line-height: 1.25;
    letter-spacing: 0.01em;
}

.thread__subtitle {
    margin: 0 0 30px;
    color: var(--muted);
    font-size: var(--text-base);
    line-height: 1.6;
}

.thread__suggestions {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    width: 100%;
}

.thread__suggestion {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    min-height: 88px;
    padding: 14px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-md);
    background: var(--surface);
    text-align: left;
    box-shadow: var(--shadow-sm);
    transition:
        border-color var(--dur-fast) var(--ease),
        background var(--dur-fast) var(--ease),
        transform var(--dur-fast) var(--ease);
}

.thread__suggestion:hover {
    border-color: var(--hairline-strong);
    background: var(--surface-raise);
    transform: translateY(-1px);
}

.thread__suggestion-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 30px;
    height: 30px;
    border-radius: var(--radius-sm);
    background: var(--accent-softer);
    color: var(--accent);
}

.thread__suggestion-body {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    flex: 1;
}

.thread__suggestion-title {
    color: var(--ink);
    font-size: var(--text-base);
    font-weight: 550;
    line-height: 1.4;
}

.thread__suggestion-caption {
    color: var(--muted);
    font-size: var(--text-xs);
    line-height: 1.55;
}

.thread__suggestion-arrow {
    flex: none;
    margin-top: 8px;
    color: var(--faint);
    opacity: 0;
    transform: translateX(-3px);
    transition:
        opacity var(--dur-fast) var(--ease),
        transform var(--dur-fast) var(--ease);
}

.thread__suggestion:hover .thread__suggestion-arrow,
.thread__suggestion:focus-visible .thread__suggestion-arrow {
    opacity: 1;
    transform: none;
}

/* ------------------------------ 加载 / 错误 ------------------------------ */

.thread__skeleton {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding-top: 8vh;
}

.thread__skeleton-line {
    height: 14px;
}

.thread__skeleton-line:nth-child(1) {
    width: 34%;
    height: 24px;
}

.thread__skeleton-line:nth-child(2) {
    width: 92%;
}

.thread__skeleton-line:nth-child(3) {
    width: 76%;
}

.thread__skeleton-line:nth-child(4) {
    width: 58%;
}

.thread__fatal {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    max-width: 420px;
    margin: auto;
    padding: 6vh 0;
    text-align: center;
}

.thread__fatal-icon {
    color: var(--danger);
}

.thread__fatal-title {
    margin: 0;
    color: var(--ink);
    font-family: var(--font-serif);
    font-size: var(--text-xl);
}

.thread__fatal-text {
    margin: 0 0 6px;
    color: var(--muted);
    font-size: var(--text-sm);
    line-height: 1.6;
    overflow-wrap: anywhere;
}

/* ------------------------------ 消息列表 ------------------------------ */

.thread__messages {
    display: flex;
    flex-direction: column;
    gap: 30px;
}

/* ------------------------------ 回到底部 ------------------------------ */

.thread__latest {
    position: absolute;
    right: 22px;
    bottom: 14px;
    z-index: 5;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 32px;
    padding: 0 12px 0 8px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-full);
    background: var(--surface-raise);
    color: var(--ink-2);
    box-shadow: var(--shadow-md);
    font-size: var(--text-xs);
    animation: rise-in var(--dur) var(--ease);
}

.thread__latest:hover {
    color: var(--ink);
    background: var(--surface);
}

.thread__latest-text {
    font-family: var(--font-sans);
}

/* ------------------------------ 状态条 ------------------------------ */

.thread__bar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
    min-height: 42px;
    padding: 6px 28px;
    border-top: 1px solid var(--hairline);
    background: var(--bg);
    color: var(--muted);
    font-size: var(--text-xs);
}

.thread__bar-spinner {
    width: 12px;
    height: 12px;
    border-width: 1.5px;
    color: var(--accent);
}

.thread__bar-icon {
    flex: none;
}

.thread__bar-text {
    flex: none;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink-2);
    font-weight: 500;
}

.thread__bar-detail {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--faint);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
}

.thread__bar-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-left: auto;
    flex: none;
    min-height: 28px;
    padding: 0 10px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-full);
    background: var(--surface);
    color: var(--muted);
    font-size: var(--text-xs);
    transition:
        background var(--dur-fast) var(--ease),
        color var(--dur-fast) var(--ease),
        border-color var(--dur-fast) var(--ease);
}

.thread__bar-btn:hover {
    background: var(--surface-2);
    color: var(--ink);
}

.thread__bar-btn:disabled {
    opacity: 0.5;
    cursor: default;
}

.thread__bar--error .thread__bar-icon,
.thread__bar--error .thread__bar-text {
    color: var(--danger);
}

.thread__bar--warn .thread__bar-icon,
.thread__bar--warn .thread__bar-text {
    color: var(--warn);
}

.thread__bar--muted .thread__bar-text {
    color: var(--muted);
}

/* ------------------------------ 窄屏 ------------------------------ */

@media (max-width: 640px) {
    .thread__inner {
        padding: 20px 16px 14px;
        gap: 24px;
    }

    .thread__title {
        font-size: var(--text-2xl);
    }

    .thread__subtitle {
        margin-bottom: 22px;
    }

    .thread__suggestions {
        grid-template-columns: minmax(0, 1fr);
        gap: 8px;
    }

    .thread__suggestion {
        min-height: 64px;
        align-items: center;
        padding: 11px 12px;
    }

    .thread__suggestion-arrow {
        margin-top: 0;
        opacity: 1;
        transform: none;
    }

    .thread__empty {
        padding: 4vh 0 6vh;
    }

    .thread__messages {
        gap: 24px;
    }

    .thread__bar {
        padding: 6px 14px;
    }

    .thread__bar-text {
        max-width: 50%;
    }

    .thread__latest {
        right: 14px;
        bottom: 10px;
    }
}
</style>
