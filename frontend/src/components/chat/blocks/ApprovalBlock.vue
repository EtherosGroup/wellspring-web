<script setup lang="ts">
/*
 * 审批卡：命令 / 目录 / 权限变化 / 理由 / 网络与超时
 * 默认焦点在拒绝；处理后展示结果
 */

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"

import Icon from "../../Icon.vue"
import { formatPermission } from "../../../lib/format"
import type { ApprovalBlock } from "../../../types"

const props = withDefaults(defineProps<{ block: ApprovalBlock; disabled?: boolean }>(), {
    disabled: false,
})

const emit = defineEmits<{ decide: [approvalId: string, approved: boolean] }>()

const denyButton = ref<HTMLButtonElement | null>(null)
const now = ref(Date.now())
let timer: number | null = null

const pending = computed(() => props.block.approved === null)
const canDecide = computed(() => pending.value && !props.disabled)

const permissionChange = computed(() => {
    const requested = props.block.requestedPermission
    if (requested === undefined || requested === "") {
        return ""
    }
    const current = props.block.currentPermission
    if (current === undefined || current === "" || current === requested) {
        return `请求 ${formatPermission(requested)}`
    }
    return `${formatPermission(current)} → ${formatPermission(requested)}`
})

const commandLine = computed(() => {
    const argv = props.block.argv
    const head = argv[0] === props.block.command ? argv : [props.block.command, ...argv]
    return head
        .filter((part) => part !== "")
        .map((part) => (/[\s"']/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part))
        .join(" ")
})

const remaining = computed(() => {
    const timeout = props.block.timeoutMs
    if (typeof timeout !== "number" || timeout <= 0) {
        return null
    }
    return Math.max(0, Math.ceil((props.block.at + timeout - now.value) / 1000))
})

function stopTimer(): void {
    if (timer !== null) {
        window.clearInterval(timer)
        timer = null
    }
}

watch(
    canDecide,
    (value) => {
        stopTimer()
        if (value && typeof props.block.timeoutMs === "number") {
            timer = window.setInterval(() => {
                now.value = Date.now()
            }, 1000)
        }
    },
    { immediate: true },
)

onMounted(() => {
    void nextTick(() => {
        if (canDecide.value) {
            denyButton.value?.focus({ preventScroll: true })
        }
    })
})

onBeforeUnmount(stopTimer)

function decide(approved: boolean): void {
    if (!canDecide.value) {
        return
    }
    emit("decide", props.block.approvalId, approved)
}
</script>

<template>
    <div class="approval" :class="{ 'approval--done': !pending }">
        <div class="approval__head">
            <Icon class="approval__icon" name="shield" :size="16" />
            <span class="approval__title">提权请求</span>
            <span v-if="permissionChange !== ''" class="badge badge--warn">{{ permissionChange }}</span>
            <span v-if="block.network" class="badge">需要网络</span>
            <span v-if="block.background" class="badge">后台运行</span>
            <span v-if="pending && remaining !== null" class="approval__timer">{{ remaining }}s 后自动拒绝</span>
        </div>

        <pre class="approval__command scroll"><code>{{ commandLine }}</code></pre>

        <dl class="approval__meta">
            <div class="approval__row">
                <dt><Icon name="folder" :size="13" />目录</dt>
                <dd :title="block.cwd">{{ block.cwd }}</dd>
            </div>
            <div v-if="block.stdin !== undefined && block.stdin !== ''" class="approval__row">
                <dt><Icon name="enter" :size="13" />输入</dt>
                <dd class="approval__stdin">{{ block.stdin }}</dd>
            </div>
        </dl>

        <blockquote v-if="block.justification !== undefined && block.justification !== ''" class="approval__reason">
            {{ block.justification }}
        </blockquote>

        <div v-if="canDecide" class="approval__actions">
            <button ref="denyButton" type="button" class="btn btn--danger btn--sm" @click="decide(false)">
                拒绝
            </button>
            <button type="button" class="btn btn--primary btn--sm" @click="decide(true)">批准</button>
        </div>
        <div v-else-if="!pending" class="approval__result" :class="block.approved ? 'approval__result--ok' : ''">
            <Icon :name="block.approved ? 'check' : 'close'" :size="15" />
            <span>{{ block.approved ? "已批准" : "已拒绝" }}</span>
        </div>
        <div v-else class="approval__result approval__result--muted">
            <Icon name="clock" :size="14" />
            <span>未处理</span>
        </div>
    </div>
</template>

<style scoped>
.approval {
    margin: 14px 0;
    padding: 13px 15px;
    border: 1px solid color-mix(in srgb, var(--warn) 32%, var(--hairline));
    border-radius: var(--radius-md);
    background: var(--surface);
    box-shadow: var(--shadow-sm);
}

.approval__head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 7px;
}

.approval__icon {
    flex: none;
    color: var(--warn);
}

.approval__title {
    color: var(--ink);
    font-size: var(--text-md);
    font-weight: 600;
}

.approval__timer {
    margin-left: auto;
    color: var(--warn);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    font-variant-numeric: tabular-nums;
}

.approval__command {
    margin: 10px 0 8px;
    padding: 8px 11px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-xs);
    background: var(--surface-2);
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    overflow: auto;
    max-height: 160px;
}

.approval__command code {
    font: inherit;
}

.approval__meta {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.approval__row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    font-size: var(--text-xs);
}

.approval__row dt {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
    width: 52px;
    color: var(--faint);
}

.approval__row dd {
    margin: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink-2);
    font-family: var(--font-mono);
}

.approval__stdin {
    white-space: pre-wrap !important;
}

.approval__reason {
    margin: 10px 0 0;
    padding: 2px 0 2px 11px;
    border-left: 2px solid color-mix(in srgb, var(--warn) 45%, transparent);
    color: var(--ink-2);
    font-size: var(--text-sm);
    line-height: 1.6;
}

.approval__actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: 13px;
}

.approval__result {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid var(--hairline);
    color: var(--danger);
    font-size: var(--text-sm);
    font-weight: 500;
}

.approval__result--ok {
    color: var(--ok);
}

.approval__result--muted {
    color: var(--faint);
    font-weight: 400;
}

@media (max-width: 640px) {
    .approval {
        padding: 12px 12px;
    }

    .approval__timer {
        margin-left: 0;
        width: 100%;
    }
}
</style>
