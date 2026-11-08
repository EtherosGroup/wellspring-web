<script setup lang="ts">
/*
 * 左侧索引栏：品牌、工作区、新建对话、会话列表（按日期分组）、底部用户与设置
 *
 * 会话行悬停显示重命名/删除；删除二次确认；运行中会话显示呼吸点。
 */
import { computed, nextTick, ref } from "vue"

import {
    actions,
    dayBucket,
    formatRelativeTime,
    store,
    themeLabel,
    type DayBucket,
} from "../../store"
import type { ConversationSummary } from "../../types"
import Icon from "../Icon.vue"
import PopMenu from "./PopMenu.vue"

interface ConversationGroup {
    key: DayBucket
    label: string
    items: ConversationSummary[]
}

const workspaceMenuOpen = ref(false)
const renamingId = ref<string | null>(null)
const renameText = ref("")
const deletingId = ref<string | null>(null)
let cancelRename = false

const groups = computed<ConversationGroup[]>(() => {
    const buckets: Record<DayBucket, ConversationSummary[]> = {
        today: [],
        yesterday: [],
        earlier: [],
    }
    for (const conversation of store.conversations) {
        buckets[dayBucket(conversation.updatedAt)].push(conversation)
    }
    const list: ConversationGroup[] = [
        { key: "today", label: "今天", items: buckets.today },
        { key: "yesterday", label: "昨天", items: buckets.yesterday },
        { key: "earlier", label: "更早", items: buckets.earlier },
    ]
    return list.filter((group) => group.items.length > 0)
})

const activeWorkspace = computed(() => {
    const id = store.conversation?.workspaceId ?? store.workspaceId
    const found = store.workspaces.find((item) => item.id === id)
    return found ?? store.workspaces[0] ?? null
})

const themeIcon = computed(() => {
    if (store.theme === "light") {
        return "sun"
    }
    if (store.theme === "dark") {
        return "moon"
    }
    return "monitor"
})

type HostTone = "ok" | "warn" | "err" | "muted"

/** getHost() 是插件加载时快照，starting 表示宿主随后会进入运行态 */
const hostState = computed<{ tone: HostTone; label: string }>(() => {
    switch (store.host?.status) {
        case "ok":
        case "running":
        case "starting":
            return { tone: "ok", label: "运行中" }
        case "stopping":
            return { tone: "warn", label: "停止中" }
        case "stopped":
            return { tone: "err", label: "已停止" }
        case "failed":
        case "error":
            return { tone: "err", label: "异常" }
        default:
            return { tone: "muted", label: "未知" }
    }
})

function openConversation(id: string): void {
    void actions.openConversation(id)
    actions.toggleSidebar(false)
}

function startRename(conversation: ConversationSummary): void {
    renamingId.value = conversation.id
    renameText.value = conversation.title
    cancelRename = false
    void nextTick(() => {
        const input = document.querySelector<HTMLInputElement>(".conv__rename-input")
        input?.focus()
        input?.select()
    })
}

async function commitRename(): Promise<void> {
    const id = renamingId.value
    if (id === null) {
        return
    }
    const title = renameText.value.trim()
    renamingId.value = null
    if (cancelRename || title === "") {
        return
    }
    await actions.renameConversation(id, title)
}

function abortRename(): void {
    cancelRename = true
    renamingId.value = null
}

async function confirmDelete(id: string): Promise<void> {
    deletingId.value = null
    await actions.deleteConversation(id)
}

function cycleTheme(): void {
    const next = store.theme === "system" ? "light" : store.theme === "light" ? "dark" : "system"
    actions.setTheme(next)
}

function selectWorkspace(id: string): void {
    workspaceMenuOpen.value = false
    void actions.setWorkspace(id)
}

function addWorkspace(): void {
    workspaceMenuOpen.value = false
    void actions.addWorkspace({ pick: true })
}
</script>

<template>
    <aside class="sidebar app__sidebar" :data-open="store.sidebarOpen" aria-label="会话索引">
        <div class="sidebar__brand">
            <span class="sidebar__mark" aria-hidden="true">
                <Icon name="spring" :size="18" />
            </span>
            <span class="sidebar__wordmark">Wellspring</span>
            <button
                class="icon-btn icon-btn--sm sidebar__close"
                type="button"
                aria-label="关闭会话列表"
                @click="actions.toggleSidebar(false)"
            >
                <Icon name="close" :size="16" />
            </button>
        </div>

        <div class="sidebar__workspace">
            <div class="sidebar__section-head">
                <span class="sidebar__label">工作区</span>
                <button
                    class="icon-btn icon-btn--sm"
                    type="button"
                    aria-label="添加工作区"
                    @click="addWorkspace"
                >
                    <Icon name="plus" :size="15" />
                </button>
            </div>
            <PopMenu
                :open="workspaceMenuOpen"
                label="切换工作区"
                :width="252"
                @close="workspaceMenuOpen = false"
            >
                <button
                    class="workspace-card"
                    type="button"
                    aria-haspopup="menu"
                    :aria-expanded="workspaceMenuOpen"
                    @click="workspaceMenuOpen = !workspaceMenuOpen"
                >
                    <span class="workspace-card__icon" aria-hidden="true">
                        <Icon name="folder" :size="15" />
                    </span>
                    <span class="workspace-card__body">
                        <span class="workspace-card__name">
                            {{ activeWorkspace?.name ?? "未选择工作区" }}
                        </span>
                        <span class="workspace-card__path" :title="activeWorkspace?.root ?? ''">
                            {{ activeWorkspace?.root ?? "添加一个目录作为工作区" }}
                        </span>
                    </span>
                    <Icon name="chevron-down" :size="14" class="workspace-card__chevron" />
                </button>
                <template #menu>
                    <p class="menu__label">工作区</p>
                    <button
                        v-for="workspace in store.workspaces"
                        :key="workspace.id"
                        class="menu__item"
                        type="button"
                        role="menuitem"
                        :aria-checked="activeWorkspace?.id === workspace.id"
                        @click="selectWorkspace(workspace.id)"
                    >
                        <Icon name="folder" :size="15" />
                        <span class="menu__workspace">{{ workspace.name }}</span>
                    </button>
                    <p v-if="store.workspaces.length === 0" class="menu__empty">暂无工作区</p>
                    <div class="menu__divider" />
                    <button class="menu__item" type="button" role="menuitem" @click="addWorkspace">
                        <Icon name="plus" :size="15" />
                        添加工作区…
                    </button>
                </template>
            </PopMenu>
        </div>

        <button class="btn btn--primary sidebar__new" type="button" @click="actions.newConversation()">
            <Icon name="plus" :size="16" />
            新对话
        </button>

        <nav class="sidebar__list scroll" aria-label="会话列表">
            <p v-if="groups.length === 0" class="sidebar__empty">暂无会话</p>
            <template v-for="group in groups" :key="group.key">
                <p class="sidebar__group-label">{{ group.label }}</p>
                <div
                    v-for="conversation in group.items"
                    :key="conversation.id"
                    class="conv"
                    :class="{ 'conv--active': store.activeId === conversation.id }"
                >
                    <div v-if="renamingId === conversation.id" class="conv__rename">
                        <input
                            v-model="renameText"
                            class="input conv__rename-input"
                            aria-label="会话标题"
                            maxlength="120"
                            @keydown.enter.prevent="commitRename"
                            @keydown.esc.prevent="abortRename"
                            @blur="commitRename"
                        />
                    </div>
                    <template v-else>
                        <button
                            class="conv__main"
                            type="button"
                            :aria-current="store.activeId === conversation.id ? 'page' : undefined"
                            @click="openConversation(conversation.id)"
                        >
                            <span class="conv__title">{{ conversation.title || "未命名对话" }}</span>
                            <span class="conv__meta">
                                <span class="conv__time">{{ formatRelativeTime(conversation.updatedAt) }}</span>
                                <span
                                    v-if="store.running[conversation.id]"
                                    class="dot dot--live"
                                    aria-label="运行中"
                                />
                            </span>
                        </button>
                        <span class="conv__actions">
                            <button
                                class="icon-btn icon-btn--sm"
                                type="button"
                                :aria-label="`重命名 ${conversation.title}`"
                                @click.stop="startRename(conversation)"
                            >
                                <Icon name="pencil" :size="14" />
                            </button>
                            <button
                                class="icon-btn icon-btn--sm"
                                type="button"
                                :aria-label="`删除 ${conversation.title}`"
                                @click.stop="deletingId = conversation.id"
                            >
                                <Icon name="trash" :size="14" />
                            </button>
                        </span>
                    </template>
                    <div v-if="deletingId === conversation.id" class="conv__confirm">
                        <span>删除此会话？</span>
                        <div class="conv__confirm-actions">
                            <button class="btn btn--sm" type="button" @click="deletingId = null">取消</button>
                            <button
                                class="btn btn--sm btn--danger"
                                type="button"
                                @click="confirmDelete(conversation.id)"
                            >
                                删除
                            </button>
                        </div>
                    </div>
                </div>
            </template>
        </nav>

        <footer class="sidebar__foot">
            <div class="sidebar__user">
                <span class="sidebar__avatar" aria-hidden="true">
                    <Icon name="user" :size="15" />
                </span>
                <span class="sidebar__user-body">
                    <span class="sidebar__user-name">{{ store.user ?? "本地用户" }}</span>
                    <span class="sidebar__host">
                        <span class="dot" :class="`dot--${hostState.tone}`" aria-hidden="true" />
                        宿主 {{ hostState.label }}
                    </span>
                </span>
            </div>
            <div class="sidebar__foot-actions">
                <button
                    class="icon-btn"
                    type="button"
                    :aria-label="`主题：${themeLabel(store.theme)}`"
                    :title="`主题：${themeLabel(store.theme)}`"
                    @click="cycleTheme"
                >
                    <Icon :name="themeIcon" :size="17" />
                </button>
                <button
                    class="icon-btn"
                    type="button"
                    aria-label="设置"
                    title="设置"
                    @click="actions.openSettings(true)"
                >
                    <Icon name="sliders" :size="17" />
                </button>
            </div>
        </footer>
    </aside>
</template>

<style scoped>
.sidebar {
    min-height: 0;
}

.sidebar__brand {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    height: var(--header-height);
    min-height: var(--header-height);
    padding: 0 var(--space-4) 0 var(--space-5);
    border-bottom: 1px solid var(--hairline);
}

.sidebar__mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm);
    background: var(--accent-soft);
    color: var(--accent-ink);
}

.sidebar__wordmark {
    font-family: var(--font-serif);
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: 0.01em;
}

.sidebar__close {
    display: none;
    margin-left: auto;
}

.sidebar__workspace {
    padding: var(--space-4) var(--space-3) 0;
}

.sidebar__section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 6px 6px;
}

.sidebar__label {
    font-size: var(--text-2xs);
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--faint);
}

.workspace-card {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: 9px 10px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-sm);
    background: var(--surface);
    text-align: left;
    transition:
        border-color var(--dur-fast) var(--ease),
        background var(--dur-fast) var(--ease);
}

.workspace-card:hover {
    border-color: var(--hairline-strong);
    background: var(--surface-raise);
}

.workspace-card__icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    flex: none;
    border-radius: var(--radius-xs);
    background: var(--surface-2);
    color: var(--muted);
}

.workspace-card__body {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
}

.workspace-card__name {
    overflow: hidden;
    color: var(--ink);
    font-size: var(--text-sm);
    font-weight: 500;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.workspace-card__path {
    overflow: hidden;
    color: var(--faint);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    line-height: 1.4;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.workspace-card__chevron {
    flex: none;
    color: var(--faint);
}

.menu__workspace {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.menu__empty {
    padding: 6px 10px;
    color: var(--faint);
    font-size: var(--text-sm);
}

.sidebar__new {
    margin: var(--space-3) var(--space-4) var(--space-2);
    height: 40px;
    justify-content: center;
}

.sidebar__list {
    flex: 1;
    min-height: 0;
    padding: var(--space-2) var(--space-2) var(--space-4);
}

.sidebar__empty {
    padding: var(--space-4) var(--space-3);
    color: var(--faint);
    font-size: var(--text-sm);
}

.sidebar__group-label {
    padding: var(--space-3) 10px 4px;
    color: var(--faint);
    font-size: var(--text-2xs);
    font-weight: 600;
    letter-spacing: 0.08em;
}

.conv {
    position: relative;
    border-radius: var(--radius-sm);
    transition: background var(--dur-fast) var(--ease);
}

.conv:hover {
    background: var(--surface-2);
}

.conv--active {
    background: var(--surface);
    box-shadow:
        inset 0 0 0 1px var(--hairline),
        var(--shadow-sm);
}

.conv--active:hover {
    background: var(--surface);
}

.conv__main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    padding: 8px 10px;
    text-align: left;
}

.conv__title {
    overflow: hidden;
    color: var(--ink-2);
    font-size: var(--text-sm);
    line-height: 1.4;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.conv--active .conv__title {
    color: var(--ink);
    font-weight: 500;
}

.conv__meta {
    display: flex;
    align-items: center;
    gap: 6px;
}

.conv__time {
    color: var(--faint);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
}

.conv__actions {
    position: absolute;
    top: 6px;
    right: 6px;
    display: none;
    align-items: center;
    gap: 2px;
    padding-left: 16px;
    background: linear-gradient(90deg, transparent, var(--surface-2) 32%);
    border-radius: var(--radius-sm);
}

.conv:hover .conv__actions,
.conv:focus-within .conv__actions {
    display: flex;
}

.conv--active .conv__actions {
    background: linear-gradient(90deg, transparent, var(--surface) 32%);
}

.conv__rename {
    padding: 6px;
}

.conv__rename-input {
    height: 32px;
    padding: 4px 8px;
    font-size: var(--text-sm);
}

.conv__confirm {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 4px 10px 10px;
    color: var(--muted);
    font-size: var(--text-sm);
}

.conv__confirm-actions {
    display: flex;
    gap: var(--space-2);
}

.sidebar__foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
    border-top: 1px solid var(--hairline);
}

.sidebar__user {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
}

.sidebar__avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    flex: none;
    border-radius: 50%;
    background: var(--surface-2);
    color: var(--muted);
}

.sidebar__user-body {
    display: flex;
    flex-direction: column;
    min-width: 0;
}

.sidebar__user-name {
    overflow: hidden;
    color: var(--ink-2);
    font-size: var(--text-sm);
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.sidebar__host {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--faint);
    font-size: var(--text-2xs);
}

.dot--warn {
    background: var(--warn);
}

.dot--muted {
    background: var(--faint);
}

.sidebar__foot-actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: 2px;
}

@media (max-width: 1023px) {
    .sidebar__close {
        display: inline-flex;
    }
}
</style>
