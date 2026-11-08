<script setup lang="ts">
/*
 * 工具行：状态 + 名称 + 参数摘要 + 耗时，展开看格式化参数与输出
 * 结果超过 4000 字符时后端标记 truncated
 */

import { computed, onBeforeUnmount, ref, useId, watch } from "vue"

import Icon from "../../Icon.vue"
import { toolElapsed } from "../../../lib/blocks"
import { formatDuration, prettyJson, summarizeToolArguments, toolIconName } from "../../../lib/format"
import type { ToolBlock } from "../../../types"

const props = withDefaults(defineProps<{ block: ToolBlock; streaming?: boolean }>(), {
    streaming: false,
})

const open = ref(false)
const now = ref(Date.now())
const panelId = useId()
let timer: number | null = null

const active = computed(() => props.streaming && props.block.status === "running" && props.block.endedAt === null)
const unfinished = computed(() => props.block.status === "running" && props.block.endedAt === null && !active.value)
const duration = computed(() => {
    const endedAt = props.block.endedAt
    if (endedAt !== null) {
        return formatDuration(endedAt - props.block.startedAt)
    }
    if (active.value) {
        return formatDuration(toolElapsed(props.block, now.value))
    }
    return "—"
})

const statusText = computed(() => {
    if (active.value) {
        return "执行中"
    }
    if (unfinished.value) {
        return "未完成"
    }
    return props.block.status === "error" ? "失败" : "成功"
})

const summary = computed(() => summarizeToolArguments(props.block.name, props.block.arguments))
const argumentsText = computed(() => prettyJson(props.block.arguments))
const hasResult = computed(() => typeof props.block.result === "string" && props.block.result.trim() !== "")

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
    <div
        class="tool"
        :class="{
            'tool--open': open,
            'tool--running': active,
            'tool--error': block.status === 'error',
            'tool--idle': unfinished,
        }"
    >
        <button
            type="button"
            class="tool__head"
            :aria-expanded="open"
            :aria-controls="panelId"
            :aria-label="`工具 ${block.name}，${statusText}，${open ? '收起' : '展开'}详情`"
            @click="open = !open"
        >
            <span class="tool__status" aria-hidden="true">
                <span v-if="active" class="spinner tool__spinner" />
                <span v-else class="dot" :class="{ 'dot--err': block.status === 'error', 'dot--ok': block.status === 'ok' }" />
            </span>
            <span class="sr-only">{{ statusText }}</span>
            <Icon class="tool__icon" :name="toolIconName(block.name)" :size="14" />
            <span class="tool__name">{{ block.name }}</span>
            <span v-if="summary !== ''" class="tool__summary">{{ summary }}</span>
            <span class="tool__duration">{{ duration }}</span>
            <Icon class="tool__chevron" :name="open ? 'chevron-up' : 'chevron-down'" :size="13" />
        </button>

        <div v-if="open" :id="panelId" class="tool__panel">
            <template v-if="argumentsText !== ''">
                <p class="tool__label">参数</p>
                <pre class="tool__pre scroll">{{ argumentsText }}</pre>
            </template>
            <template v-if="hasResult">
                <p class="tool__label">输出</p>
                <pre
                    class="tool__pre tool__pre--result scroll"
                    :class="{ 'tool__pre--error': block.status === 'error' }"
                >{{ block.result }}</pre>
                <p v-if="block.truncated" class="tool__hint tool__hint--warn">
                    <Icon name="alert" :size="13" />
                    输出已截断（最多 4000 字符）
                </p>
            </template>
            <p v-else-if="active" class="tool__hint">执行中</p>
            <p v-else class="tool__hint">无输出</p>
        </div>
    </div>
</template>

<style scoped>
.tool {
    margin: 3px 0;
}

.tool__head {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    min-height: 32px;
    padding: 2px 6px 2px 2px;
    border-radius: var(--radius-xs);
    text-align: left;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.5;
    transition:
        background var(--dur-fast) var(--ease),
        color var(--dur-fast) var(--ease);
}

.tool__head:hover {
    background: var(--surface-2);
    color: var(--ink-2);
}

.tool__status {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 12px;
    flex: none;
}

.tool__spinner {
    width: 11px;
    height: 11px;
    border-width: 1.5px;
    color: var(--accent);
}

.tool__icon {
    flex: none;
    color: var(--faint);
}

.tool--running .tool__icon {
    color: var(--accent);
}

.tool--error .tool__icon {
    color: var(--danger);
}

.tool__name {
    flex: none;
    color: var(--ink-2);
    font-weight: 500;
}

.tool__summary {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--faint);
}

.tool__duration {
    flex: none;
    color: var(--faint);
    font-variant-numeric: tabular-nums;
}

.tool__chevron {
    flex: none;
    color: var(--faint);
}

.tool__panel {
    margin: 4px 0 8px 19px;
    padding: 2px 0 2px 12px;
    border-left: 1px solid var(--hairline);
}

.tool__label {
    margin: 6px 0 4px;
    color: var(--faint);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: 0.06em;
    text-transform: uppercase;
}

.tool__pre {
    margin: 0 0 8px;
    padding: 8px 10px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-xs);
    background: var(--surface-2);
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    overflow: auto;
    max-height: 300px;
}

.tool__pre--error {
    border-color: color-mix(in srgb, var(--danger) 35%, var(--hairline));
    background: var(--danger-soft);
    color: var(--danger);
}

.tool__hint {
    display: flex;
    align-items: center;
    gap: 5px;
    margin: 0 0 6px;
    color: var(--faint);
    font-size: var(--text-xs);
}

.tool__hint--warn {
    color: var(--warn);
}
</style>
