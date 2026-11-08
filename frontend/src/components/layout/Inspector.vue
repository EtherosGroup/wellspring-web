<script setup lang="ts">
/*
 * 右侧上下文栏：会话概览（模型/推理/权限/cwd/轮步/用量/缓存）与工具时间线
 *
 * 数据全部来自 store.conversation；工具时间线从消息 blocks 里的 tool 块提取。
 */
import { computed } from "vue"

import {
    actions,
    conversationModelLabel,
    currentRoot,
    formatDuration,
    formatTokens,
    permissionLabel,
    reasoningLabel,
    store,
} from "../../store"
import type { ToolBlock } from "../../types"
import Icon from "../Icon.vue"

interface TimelineEntry {
    block: ToolBlock
    at: number
}

const conversation = computed(() => store.conversation)
const usage = computed(() => conversation.value?.usage ?? null)

const reasoning = computed(() => {
    const value = conversation.value?.reasoning ?? store.models?.activeReasoning ?? null
    return reasoningLabel(value)
})

const root = computed(() => conversation.value?.cwd ?? currentRoot())

const cacheHit = computed<number | null>(() => {
    const current = usage.value
    if (current === null) {
        return null
    }
    const input = current.inputTokens
    const cached = current.cacheReadTokens
    if (typeof input !== "number" || typeof cached !== "number" || input <= 0) {
        return null
    }
    return Math.min(100, Math.round((cached / input) * 100))
})

const timeline = computed<TimelineEntry[]>(() => {
    const target = conversation.value
    if (target === null) {
        return []
    }
    const entries: TimelineEntry[] = []
    for (const message of target.messages) {
        for (const block of message.blocks) {
            if (block.type === "tool") {
                entries.push({ block, at: block.startedAt })
            }
        }
    }
    entries.sort((a, b) => b.at - a.at)
    return entries.slice(0, 40)
})

function toolStatusText(block: ToolBlock): string {
    if (block.status === "running") {
        return "执行中"
    }
    return block.status === "error" ? "失败" : "完成"
}

function toolDuration(block: ToolBlock): string {
    if (block.endedAt === null) {
        return formatDuration(Date.now() - block.startedAt)
    }
    return formatDuration(block.endedAt - block.startedAt)
}

function toolSummary(block: ToolBlock): string {
    const args = block.arguments?.trim() ?? ""
    if (args === "") {
        return ""
    }
    const firstLine = args.split("\n")[0] ?? ""
    return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine
}

function copySessionId(): void {
    const sessionId = conversation.value?.sessionId
    if (sessionId === null || sessionId === undefined) {
        return
    }
    void navigator.clipboard
        .writeText(sessionId)
        .then(() => actions.toast("会话 ID 已复制", "success"))
        .catch(() => actions.toast("复制失败", "error"))
}
</script>

<template>
    <aside class="inspector app__inspector" :data-open="store.inspectorOpen" aria-label="上下文">
        <header class="inspector__head">
            <h2 class="inspector__title">上下文</h2>
            <button
                class="icon-btn icon-btn--sm inspector__close"
                type="button"
                aria-label="关闭上下文面板"
                @click="actions.toggleInspector(false)"
            >
                <Icon name="close" :size="16" />
            </button>
        </header>

        <div class="inspector__body scroll">
            <p v-if="conversation === null" class="inspector__empty">选择或新建会话后显示上下文</p>
            <template v-else>
                <section class="inspector__section">
                    <h3 class="inspector__section-title">概览</h3>
                    <dl class="meta">
                        <div class="meta__row">
                            <dt>模型</dt>
                            <dd :title="conversationModelLabel(conversation)">
                                <Icon name="cpu" :size="14" class="meta__icon" />
                                {{ conversationModelLabel(conversation) }}
                            </dd>
                        </div>
                        <div class="meta__row">
                            <dt>推理</dt>
                            <dd>
                                <Icon name="gauge" :size="14" class="meta__icon" />
                                {{ reasoning }}
                            </dd>
                        </div>
                        <div class="meta__row">
                            <dt>权限</dt>
                            <dd>
                                <Icon name="shield" :size="14" class="meta__icon" />
                                {{ permissionLabel(conversation.permission) }}
                            </dd>
                        </div>
                        <div class="meta__row">
                            <dt>目录</dt>
                            <dd>
                                <button
                                    class="meta__path"
                                    type="button"
                                    :title="root === null ? '未设置' : `${root}（点击在文件管理器中显示）`"
                                    @click="root !== null && actions.openPath(root, 'reveal')"
                                >
                                    {{ root ?? "宿主当前目录" }}
                                </button>
                            </dd>
                        </div>
                        <div class="meta__row">
                            <dt>轮 / 步</dt>
                            <dd>{{ conversation.turns }} / {{ conversation.steps }}</dd>
                        </div>
                        <div v-if="conversation.sessionId !== null" class="meta__row">
                            <dt>宿主会话</dt>
                            <dd class="meta__session">
                                <span class="meta__mono" :title="conversation.sessionId ?? ''">
                                    {{ conversation.sessionId }}
                                </span>
                                <button
                                    class="icon-btn icon-btn--sm"
                                    type="button"
                                    aria-label="复制宿主会话 ID"
                                    @click="copySessionId"
                                >
                                    <Icon name="copy" :size="13" />
                                </button>
                            </dd>
                        </div>
                    </dl>
                </section>

                <section class="inspector__section">
                    <h3 class="inspector__section-title">用量</h3>
                    <div v-if="usage === null" class="inspector__note">本轮尚无用量数据</div>
                    <template v-else>
                        <div class="usage">
                            <div class="usage__cell">
                                <span class="usage__label">输入</span>
                                <span class="usage__value">{{ formatTokens(usage.inputTokens) }}</span>
                            </div>
                            <div class="usage__cell">
                                <span class="usage__label">输出</span>
                                <span class="usage__value">{{ formatTokens(usage.outputTokens) }}</span>
                            </div>
                            <div class="usage__cell">
                                <span class="usage__label">缓存读</span>
                                <span class="usage__value">{{ formatTokens(usage.cacheReadTokens) }}</span>
                            </div>
                            <div class="usage__cell">
                                <span class="usage__label">上下文</span>
                                <span class="usage__value">{{ formatTokens(usage.contextTokens) }}</span>
                            </div>
                        </div>
                        <div v-if="cacheHit !== null" class="usage__cache">
                            <span class="usage__cache-track" aria-hidden="true">
                                <span class="usage__cache-fill" :style="{ width: `${cacheHit}%` }" />
                            </span>
                            <span class="usage__cache-text">缓存命中 {{ cacheHit }}%</span>
                        </div>
                    </template>
                </section>

                <section class="inspector__section inspector__section--grow">
                    <h3 class="inspector__section-title">
                        工具时间线
                        <span class="badge">{{ timeline.length }}</span>
                    </h3>
                    <p v-if="timeline.length === 0" class="inspector__note">暂无工具调用</p>
                    <ol v-else class="timeline">
                        <li v-for="entry in timeline" :key="`${entry.block.id}-${entry.at}`" class="timeline__item">
                            <span
                                class="timeline__dot"
                                :class="{
                                    'timeline__dot--running': entry.block.status === 'running',
                                    'timeline__dot--error': entry.block.status === 'error',
                                }"
                                aria-hidden="true"
                            />
                            <details class="timeline__details">
                                <summary class="timeline__summary">
                                    <span class="timeline__name">{{ entry.block.name }}</span>
                                    <span class="timeline__status">{{ toolStatusText(entry.block) }}</span>
                                    <span class="timeline__time">{{ toolDuration(entry.block) }}</span>
                                </summary>
                                <p v-if="toolSummary(entry.block) !== ''" class="timeline__args">
                                    {{ toolSummary(entry.block) }}
                                </p>
                                <pre v-if="entry.block.arguments" class="timeline__pre">{{ entry.block.arguments }}</pre>
                                <pre v-if="entry.block.result" class="timeline__pre timeline__pre--result">{{ entry.block.result }}</pre>
                            </details>
                        </li>
                    </ol>
                </section>
            </template>
        </div>
    </aside>
</template>

<style scoped>
.inspector {
    min-height: 0;
}

.inspector__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: var(--header-height);
    min-height: var(--header-height);
    padding: 0 var(--space-3) 0 var(--space-5);
    border-bottom: 1px solid var(--hairline);
}

.inspector__title {
    font-family: var(--font-serif);
    font-size: var(--text-md);
    font-weight: 600;
}

.inspector__close {
    display: none;
}

.inspector__body {
    flex: 1;
    min-height: 0;
    padding: var(--space-4) var(--space-4) var(--space-8);
}

.inspector__empty {
    padding: var(--space-6) var(--space-2);
    color: var(--faint);
    font-size: var(--text-sm);
    text-align: center;
}

.inspector__section {
    padding-bottom: var(--space-5);
    border-bottom: 1px solid var(--hairline);
    margin-bottom: var(--space-5);
}

.inspector__section--grow {
    border-bottom: none;
    margin-bottom: 0;
}

.inspector__section-title {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
    color: var(--faint);
    font-size: var(--text-2xs);
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
}

.inspector__note {
    color: var(--faint);
    font-size: var(--text-sm);
}

.meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
}

.meta__row {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    padding: 5px 0;
}

.meta__row dt {
    flex: none;
    width: 64px;
    color: var(--faint);
    font-size: var(--text-xs);
}

.meta__row dd {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    margin: 0;
    color: var(--ink-2);
    font-size: var(--text-sm);
}

.meta__icon {
    flex: none;
    color: var(--faint);
}

.meta__path {
    overflow: hidden;
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.meta__path:hover {
    text-decoration: underline;
}

.meta__session {
    overflow: hidden;
}

.meta__mono {
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.usage {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-2);
}

.usage__cell {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 8px 10px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-sm);
    background: var(--surface);
}

.usage__label {
    color: var(--faint);
    font-size: var(--text-2xs);
}

.usage__value {
    font-family: var(--font-mono);
    font-size: var(--text-md);
}

.usage__cache {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-3);
}

.usage__cache-track {
    flex: 1;
    height: 4px;
    overflow: hidden;
    border-radius: var(--radius-full);
    background: var(--surface-3);
}

.usage__cache-fill {
    display: block;
    height: 100%;
    border-radius: var(--radius-full);
    background: var(--accent);
}

.usage__cache-text {
    flex: none;
    color: var(--faint);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
}

.timeline {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
}

.timeline__item {
    display: flex;
    gap: var(--space-2);
    padding: 6px 0 6px 2px;
}

.timeline__dot {
    width: 7px;
    height: 7px;
    flex: none;
    margin-top: 6px;
    border-radius: 50%;
    background: var(--ok);
}

.timeline__dot--running {
    background: var(--accent);
    animation: pulse 1.8s var(--ease) infinite;
}

.timeline__dot--error {
    background: var(--danger);
}

.timeline__details {
    min-width: 0;
    flex: 1;
}

.timeline__summary {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    color: var(--ink-2);
    font-size: var(--text-sm);
    cursor: pointer;
    list-style: none;
}

.timeline__summary::-webkit-details-marker {
    display: none;
}

.timeline__name {
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.timeline__status {
    color: var(--faint);
    font-size: var(--text-2xs);
}

.timeline__time {
    margin-left: auto;
    flex: none;
    color: var(--faint);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
}

.timeline__args {
    margin-top: 4px;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    overflow-wrap: anywhere;
}

.timeline__pre {
    margin: 6px 0 0;
    padding: 8px;
    overflow-x: auto;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-xs);
    background: var(--surface);
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}

.timeline__pre--result {
    color: var(--muted);
}

@media (max-width: 1023px) {
    .inspector__close {
        display: inline-flex;
    }
}
</style>
