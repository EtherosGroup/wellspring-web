<script setup lang="ts">
/*
 * 单条消息
 *
 * 用户：右对齐纸卡 + 时间，@引用高亮
 * 助手：全宽文档排版，左侧时间线轴 + spring 标记，按 blocks 顺序渲染
 */

import { computed } from "vue"

import Icon from "../Icon.vue"
import { formatClock, formatDuration, formatTokens } from "../../lib/format"
import type { ChatMessage } from "../../types"
import ApprovalBlock from "./blocks/ApprovalBlock.vue"
import AskBlock from "./blocks/AskBlock.vue"
import NoteBlock from "./blocks/NoteBlock.vue"
import ReasoningBlock from "./blocks/ReasoningBlock.vue"
import SteerBlock from "./blocks/SteerBlock.vue"
import TextBlock from "./blocks/TextBlock.vue"
import ToolBlock from "./blocks/ToolBlock.vue"

const props = defineProps<{ message: ChatMessage; streaming: boolean }>()

const emit = defineEmits<{
    retry: []
    answer: [askId: string, answer: string]
    skip: [askId: string]
    decide: [approvalId: string, approved: boolean]
}>()

const isStreaming = computed(() => props.streaming && props.message.status === "streaming")

/** 错误详情由警示条展示，过滤 store 写入的同文 note */
const blocks = computed(() => {
    const error = props.message.error
    return props.message.blocks.filter((block) => {
        if (
            error !== undefined &&
            error !== "" &&
            block.type === "note" &&
            block.tone === "warn" &&
            block.text === error
        ) {
            return false
        }
        return true
    })
})

const fallbackText = computed(() => {
    if (props.message.blocks.length > 0 || props.message.text.trim() === "") {
        return ""
    }
    return props.message.text
})

const lastTextIndex = computed(() => {
    for (let index = blocks.value.length - 1; index >= 0; index -= 1) {
        const block = blocks.value[index]
        if (block !== undefined && block.type === "text") {
            return index
        }
    }
    return -1
})

const tailCaret = computed(() => isStreaming.value && blocks.value.length === 0)

const clock = computed(() => formatClock(props.message.at))
const isoTime = computed(() => new Date(props.message.at).toISOString())
const stepsText = computed(() => {
    const steps = props.message.steps
    return typeof steps === "number" && steps > 0 ? `${steps} 步` : ""
})
const durationText = computed(() => {
    const startedAt = props.message.startedAt
    const endedAt = props.message.endedAt
    if (startedAt === undefined || endedAt === undefined || endedAt <= startedAt) {
        return ""
    }
    return formatDuration(endedAt - startedAt)
})
const usageText = computed(() => {
    const usage = props.message.usage
    if (usage === null || usage === undefined) {
        return ""
    }
    const parts: string[] = []
    if (typeof usage.inputTokens === "number") {
        parts.push(`入 ${formatTokens(usage.inputTokens)}`)
    }
    if (typeof usage.outputTokens === "number") {
        parts.push(`出 ${formatTokens(usage.outputTokens)}`)
    }
    return parts.join(" · ")
})
const footerVisible = computed(
    () => props.message.status !== "streaming" && (durationText.value !== "" || usageText.value !== ""),
)

interface UserPart {
    text: string
    ref: boolean
}

/* @引用：前面须是行首、空白或括号，避免把邮箱地址当成引用 */
const REF_PATTERN = /(^|[\s（(「])(@[^\s@，。；、）)」]+)/g

const userParts = computed<UserPart[]>(() => {
    const text = props.message.text
    const parts: UserPart[] = []
    let cursor = 0
    let match: RegExpExecArray | null = null
    REF_PATTERN.lastIndex = 0
    while ((match = REF_PATTERN.exec(text)) !== null) {
        const lead = match[1] ?? ""
        const ref = match[2] ?? ""
        const start = match.index
        const plain = text.slice(cursor, start) + lead
        if (plain !== "") {
            parts.push({ text: plain, ref: false })
        }
        if (ref !== "") {
            parts.push({ text: ref, ref: true })
        }
        cursor = start + match[0].length
    }
    const rest = text.slice(cursor)
    if (rest !== "") {
        parts.push({ text: rest, ref: false })
    }
    return parts
})

function onAnswer(askId: string, answer: string): void {
    emit("answer", askId, answer)
}

function onSkip(askId: string): void {
    emit("skip", askId)
}

function onDecide(approvalId: string, approved: boolean): void {
    emit("decide", approvalId, approved)
}

function onRetry(): void {
    emit("retry")
}
</script>

<template>
    <!-- 用户消息 -->
    <article v-if="message.role === 'user'" class="msg msg--user">
        <div class="msg__card">
            <p class="msg__user-text">
                <template v-for="(part, index) in userParts" :key="index">
                    <span v-if="part.ref" class="msg__ref">{{ part.text }}</span>
                    <template v-else>{{ part.text }}</template>
                </template>
            </p>
        </div>
        <div class="msg__user-meta">
            <time :datetime="isoTime">{{ clock }}</time>
        </div>
    </article>

    <!-- 助手消息 -->
    <article v-else class="msg msg--assistant">
        <div class="msg__rail" aria-hidden="true">
            <span class="msg__mark"><Icon name="spring" :size="13" /></span>
        </div>
        <div class="msg__doc">
            <header class="msg__head">
                <span class="msg__author">Wellspring</span>
                <span v-if="message.model" class="msg__model">{{ message.model }}</span>
                <time class="msg__time" :datetime="isoTime">{{ clock }}</time>
                <span v-if="stepsText !== ''" class="msg__steps">{{ stepsText }}</span>
            </header>

            <div
                class="msg__blocks"
                :aria-live="isStreaming ? 'polite' : undefined"
                :aria-busy="isStreaming ? 'true' : undefined"
            >
                <template v-for="(block, index) in blocks" :key="index">
                    <TextBlock
                        v-if="block.type === 'text'"
                        :block="block"
                        :streaming="isStreaming && index === lastTextIndex && index === blocks.length - 1"
                    />
                    <ReasoningBlock
                        v-else-if="block.type === 'reasoning'"
                        :block="block"
                        :streaming="isStreaming"
                    />
                    <ToolBlock v-else-if="block.type === 'tool'" :block="block" :streaming="isStreaming" />
                    <SteerBlock v-else-if="block.type === 'steer'" :block="block" />
                    <AskBlock
                        v-else-if="block.type === 'ask'"
                        :block="block"
                        :disabled="!isStreaming"
                        @answer="onAnswer"
                        @skip="onSkip"
                    />
                    <ApprovalBlock
                        v-else-if="block.type === 'approval'"
                        :block="block"
                        :disabled="!isStreaming"
                        @decide="onDecide"
                    />
                    <NoteBlock v-else-if="block.type === 'note'" :block="block" />
                </template>

                <TextBlock
                    v-if="fallbackText !== ''"
                    :block="{ type: 'text', text: fallbackText }"
                    :streaming="false"
                />
                <span v-if="tailCaret" class="msg__caret" aria-hidden="true" />
            </div>

            <div v-if="message.status === 'error'" class="msg__alert">
                <Icon class="msg__alert-icon" name="alert-circle" :size="15" />
                <span class="msg__alert-text">{{ message.error ?? "本轮失败" }}</span>
                <button type="button" class="btn btn--sm msg__alert-action" @click="onRetry">重试</button>
            </div>
            <div v-else-if="message.status === 'interrupted'" class="msg__alert msg__alert--warn">
                <Icon class="msg__alert-icon" name="alert" :size="15" />
                <span class="msg__alert-text">{{ message.error ?? "连接中断" }}</span>
                <button type="button" class="btn btn--sm msg__alert-action" @click="onRetry">续接</button>
            </div>

            <footer v-if="footerVisible || message.status === 'stopped'" class="msg__foot">
                <span v-if="message.status === 'stopped'" class="msg__state">已停止</span>
                <span v-if="durationText !== ''">{{ durationText }}</span>
                <span v-if="usageText !== ''">{{ usageText }}</span>
            </footer>
        </div>
    </article>
</template>

<style scoped>
.msg {
    min-width: 0;
}

/* 用户消息 */

.msg--user {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
}

.msg__card {
    max-width: min(84%, 560px);
    padding: 10px 14px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-lg) var(--radius-lg) 6px var(--radius-lg);
    background: var(--user-bubble);
    box-shadow: var(--shadow-sm);
}

.msg__user-text {
    margin: 0;
    color: var(--ink);
    font-size: var(--text-md);
    line-height: 1.65;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}

.msg__ref {
    padding: 0 4px;
    border-radius: 4px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-family: var(--font-mono);
    font-size: 0.88em;
    white-space: nowrap;
}

.msg__user-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-right: 4px;
    color: var(--faint);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
}

/* 助手消息 */

.msg--assistant {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr);
    gap: 11px;
}

.msg__rail {
    position: relative;
    display: flex;
    justify-content: center;
    padding-top: 1px;
}

.msg__rail::before {
    content: "";
    position: absolute;
    top: 26px;
    bottom: -30px;
    left: 50%;
    width: 1px;
    transform: translateX(-50%);
    background: var(--hairline);
}

.msg--assistant:last-child .msg__rail::before {
    bottom: 0;
}

.msg__mark {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: 1px solid var(--hairline);
    border-radius: 50%;
    background: var(--surface);
    color: var(--accent);
    box-shadow: var(--shadow-sm);
}

.msg__doc {
    min-width: 0;
}

.msg__head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 7px;
}

.msg__author {
    color: var(--ink);
    font-family: var(--font-serif);
    font-size: var(--text-sm);
    letter-spacing: 0.01em;
}

.msg__model {
    padding: 1px 7px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-full);
    background: var(--surface-2);
    color: var(--faint);
    font-family: var(--font-mono);
    font-size: 0.625rem;
    line-height: 1.6;
}

.msg__time,
.msg__steps {
    color: var(--faint);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    font-variant-numeric: tabular-nums;
}

.msg__steps {
    margin-left: auto;
}

.msg__blocks {
    min-width: 0;
}

.msg__caret {
    display: inline-block;
    width: 2px;
    height: 1.05em;
    margin-top: 4px;
    border-radius: 1px;
    background: var(--accent);
    animation: caret-blink 1.1s steps(1, end) infinite;
}

/* 错误 / 中断 */

.msg__alert {
    display: flex;
    align-items: flex-start;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
    padding: 9px 12px;
    border: 1px solid color-mix(in srgb, var(--danger) 34%, var(--hairline));
    border-radius: var(--radius-sm);
    background: var(--danger-soft);
    color: var(--danger);
    font-size: var(--text-sm);
    line-height: 1.55;
}

.msg__alert-icon {
    margin-top: 2px;
    flex: none;
}

.msg__alert-text {
    min-width: 0;
    flex: 1;
    overflow-wrap: anywhere;
}

.msg__alert-action {
    margin-left: auto;
    background: var(--surface);
}

.msg__alert--warn {
    border-color: color-mix(in srgb, var(--warn) 34%, var(--hairline));
    background: var(--warn-soft);
    color: var(--warn);
}

/* 页脚 */

.msg__foot {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 10px;
    color: var(--faint);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    font-variant-numeric: tabular-nums;
}

.msg__state {
    padding: 1px 7px;
    border-radius: var(--radius-full);
    background: var(--surface-2);
    color: var(--muted);
}

@media (max-width: 640px) {
    .msg--assistant {
        grid-template-columns: 18px minmax(0, 1fr);
        gap: 8px;
    }

    .msg__mark {
        width: 18px;
        height: 18px;
    }

    .msg__rail::before {
        top: 22px;
        bottom: -24px;
    }

    .msg__card {
        max-width: 92%;
    }
}
</style>
