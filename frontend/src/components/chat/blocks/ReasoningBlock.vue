<script setup lang="ts">
/*
 * 思考块：默认折叠一行，展开看思考正文
 * 流式中按秒刷新用时，末行作为摘要
 */

import { computed, onBeforeUnmount, ref, watch } from "vue"

import Icon from "../../Icon.vue"
import { reasoningElapsed } from "../../../lib/blocks"
import { formatReasoningTime } from "../../../lib/format"
import type { ReasoningBlock } from "../../../types"

const props = withDefaults(defineProps<{ block: ReasoningBlock; streaming?: boolean }>(), {
    streaming: false,
})

const open = ref(false)
const now = ref(Date.now())
let timer: number | null = null

const active = computed(() => props.streaming && props.block.endedAt === null)
const elapsed = computed(() => reasoningElapsed(props.block, now.value))
const label = computed(() =>
    active.value ? `思考中 · ${formatReasoningTime(elapsed.value)}` : `思考了 ${formatReasoningTime(elapsed.value)}`,
)

const summary = computed(() => {
    const lines = props.block.text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
    const line = (active.value ? lines[lines.length - 1] : lines[0]) ?? ""
    return line.slice(0, 90)
})

function stopTimer(): void {
    if (timer !== null) {
        window.clearInterval(timer)
        timer = null
    }
}

watch(
    active,
    (value) => {
        stopTimer()
        if (value) {
            timer = window.setInterval(() => {
                now.value = Date.now()
            }, 1000)
        }
    },
    { immediate: true },
)

onBeforeUnmount(stopTimer)
</script>

<template>
    <div class="reasoning" :class="{ 'reasoning--active': active, 'reasoning--open': open }">
        <button
            type="button"
            class="reasoning__head"
            :aria-expanded="open"
            :aria-label="`${label}，${open ? '收起' : '展开'}思考过程`"
            @click="open = !open"
        >
            <Icon class="reasoning__icon" name="sparkles" :size="14" />
            <span class="reasoning__label">{{ label }}</span>
            <span v-if="!open && summary !== ''" class="reasoning__summary">{{ summary }}</span>
            <Icon class="reasoning__chevron" :name="open ? 'chevron-up' : 'chevron-down'" :size="14" />
        </button>
        <div v-if="open" class="reasoning__body scroll">{{ block.text }}</div>
    </div>
</template>

<style scoped>
.reasoning {
    margin: 6px 0 10px;
}

.reasoning__head {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    min-height: 32px;
    padding: 2px 0;
    text-align: left;
    color: var(--muted);
    font-size: var(--text-sm);
    line-height: 1.5;
    transition: color var(--dur-fast) var(--ease);
}

.reasoning__head:hover {
    color: var(--ink-2);
}

.reasoning__icon {
    flex: none;
    color: var(--faint);
}

.reasoning--active .reasoning__icon {
    color: var(--accent);
}

.reasoning__label {
    flex: none;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
}

.reasoning__summary {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--faint);
    font-size: var(--text-xs);
}

.reasoning__chevron {
    flex: none;
    color: var(--faint);
    margin-left: auto;
}

.reasoning__summary + .reasoning__chevron {
    margin-left: 0;
}

.reasoning__body {
    max-height: 320px;
    margin: 2px 0 4px 21px;
    padding: 4px 0 4px 12px;
    border-left: 1px solid var(--hairline);
    color: var(--muted);
    font-size: var(--text-sm);
    line-height: 1.7;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
</style>
