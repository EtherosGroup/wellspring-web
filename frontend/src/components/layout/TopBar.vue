<script setup lang="ts">
/*
 * 顶栏：会话标题、轮/步与模型元信息、检查器开关、更多菜单
 *
 * 重命名与删除用内联对话框，避免浏览器原生 prompt/confirm 打断工作台气质。
 */
import { computed, nextTick, ref } from "vue"

import { actions, conversationModelLabel, currentRoot, store } from "../../store"
import Icon from "../Icon.vue"
import PopMenu from "./PopMenu.vue"

const menuOpen = ref(false)
const renameOpen = ref(false)
const renameText = ref("")
const renameInput = ref<HTMLInputElement | null>(null)
const deleteOpen = ref(false)

const title = computed(() => {
    const conversation = store.conversation
    if (conversation === null || conversation.title.trim() === "") {
        return "新对话"
    }
    return conversation.title
})

const conversation = computed(() => store.conversation)
const workspaceRoot = computed(() => conversation.value?.cwd ?? currentRoot())

function openRename(): void {
    const target = store.conversation
    if (target === null) {
        return
    }
    renameText.value = target.title
    renameOpen.value = true
    void nextTick(() => {
        renameInput.value?.focus()
        renameInput.value?.select()
    })
}

async function submitRename(): Promise<void> {
    const target = store.conversation
    const value = renameText.value.trim()
    if (target === null || value === "") {
        renameOpen.value = false
        return
    }
    renameOpen.value = false
    await actions.renameConversation(target.id, value)
}

function openDelete(): void {
    if (store.conversation === null) {
        return
    }
    deleteOpen.value = true
}

async function confirmDelete(): Promise<void> {
    const target = store.conversation
    deleteOpen.value = false
    if (target === null) {
        return
    }
    await actions.deleteConversation(target.id)
}

async function copyId(): Promise<void> {
    const target = store.conversation
    if (target === null) {
        return
    }
    try {
        await navigator.clipboard.writeText(target.id)
        actions.toast("会话 ID 已复制", "success")
    } catch {
        actions.toast("复制失败", "error")
    }
}

async function revealWorkspace(): Promise<void> {
    const root = workspaceRoot.value
    if (root === null) {
        actions.toast("未找到工作目录", "error")
        return
    }
    await actions.openPath(root, "reveal")
}
</script>

<template>
    <header class="topbar">
        <div class="topbar__left">
            <button
                class="icon-btn topbar__sidebar"
                type="button"
                aria-label="打开会话列表"
                :aria-expanded="store.sidebarOpen"
                @click="actions.toggleSidebar()"
            >
                <Icon name="panel-left" />
            </button>
            <div class="topbar__titles">
                <h1 class="topbar__title" :title="title">{{ title }}</h1>
                <p v-if="conversation !== null" class="topbar__meta">
                    <span class="topbar__turns">{{ conversation.turns }} 轮 · {{ conversation.steps }} 步</span>
                    <span class="topbar__sep" aria-hidden="true">·</span>
                    <span class="topbar__model" :title="conversationModelLabel(conversation)">
                        {{ conversationModelLabel(conversation) }}
                    </span>
                    <span v-if="store.streaming" class="topbar__live">
                        <span class="dot dot--live" aria-hidden="true" />
                        运行中
                    </span>
                </p>
            </div>
        </div>
        <div class="topbar__right">
            <button
                class="icon-btn"
                type="button"
                aria-label="上下文面板"
                :aria-pressed="store.inspectorOpen"
                @click="actions.toggleInspector()"
            >
                <Icon name="panel-right" />
            </button>
            <PopMenu
                v-if="conversation !== null"
                :open="menuOpen"
                align="end"
                label="会话菜单"
                :width="188"
                @close="menuOpen = false"
            >
                <button
                    class="icon-btn"
                    type="button"
                    aria-label="更多操作"
                    aria-haspopup="menu"
                    :aria-expanded="menuOpen"
                    @click="menuOpen = !menuOpen"
                >
                    <Icon name="more" />
                </button>
                <template #menu>
                    <button class="menu__item" type="button" role="menuitem" @click="openRename">
                        <Icon name="pencil" :size="15" />
                        重命名
                    </button>
                    <button class="menu__item" type="button" role="menuitem" @click="copyId">
                        <Icon name="copy" :size="15" />
                        复制会话 ID
                    </button>
                    <button class="menu__item" type="button" role="menuitem" @click="revealWorkspace">
                        <Icon name="folder" :size="15" />
                        打开工作目录
                    </button>
                    <button class="menu__item" type="button" role="menuitem" @click="actions.refresh()">
                        <Icon name="refresh" :size="15" />
                        刷新会话
                    </button>
                    <div class="menu__divider" />
                    <button class="menu__item menu__item--danger" type="button" role="menuitem" @click="openDelete">
                        <Icon name="trash" :size="15" />
                        删除会话
                    </button>
                </template>
            </PopMenu>
        </div>
    </header>

    <Teleport to="body">
        <div v-if="renameOpen" class="dialog-backdrop" @click.self="renameOpen = false">
            <form class="dialog" role="dialog" aria-modal="true" aria-labelledby="rename-title" @submit.prevent="submitRename">
                <h2 id="rename-title" class="dialog__title">重命名会话</h2>
                <div class="field">
                    <label for="rename-input">标题</label>
                    <input
                        id="rename-input"
                        ref="renameInput"
                        v-model="renameText"
                        class="input"
                        maxlength="120"
                        autocomplete="off"
                        @keydown.esc="renameOpen = false"
                    />
                </div>
                <div class="dialog__actions">
                    <button class="btn" type="button" @click="renameOpen = false">取消</button>
                    <button class="btn btn--primary" type="submit" :disabled="renameText.trim() === ''">保存</button>
                </div>
            </form>
        </div>
        <div v-if="deleteOpen" class="dialog-backdrop" @click.self="deleteOpen = false">
            <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-desc">
                <h2 id="delete-title" class="dialog__title">删除会话</h2>
                <p id="delete-desc" class="dialog__text">「{{ title }}」及其消息将永久删除。</p>
                <div class="dialog__actions">
                    <button class="btn" type="button" @click="deleteOpen = false">取消</button>
                    <button class="btn btn--danger" type="button" @click="confirmDelete">删除</button>
                </div>
            </div>
        </div>
    </Teleport>
</template>

<style scoped>
.topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    height: var(--header-height);
    min-height: var(--header-height);
    padding: 0 var(--space-5);
    border-bottom: 1px solid var(--hairline);
    background: color-mix(in srgb, var(--bg) 86%, transparent);
    backdrop-filter: blur(6px);
}

.topbar__left {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
}

.topbar__sidebar {
    display: none;
}

.topbar__titles {
    min-width: 0;
}

.topbar__title {
    overflow: hidden;
    font-family: var(--font-serif);
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: 0.01em;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.topbar__meta {
    display: flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
    color: var(--faint);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: 0.02em;
    white-space: nowrap;
}

.topbar__sep {
    color: var(--hairline-strong);
}

.topbar__turns {
    color: var(--faint);
}

.topbar__model {
    overflow: hidden;
    max-width: 240px;
    padding: 1px 8px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-full);
    background: var(--surface-2);
    color: var(--muted);
    text-overflow: ellipsis;
}

.topbar__live {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--accent);
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
}

.topbar__right {
    display: flex;
    align-items: center;
    gap: var(--space-1);
}

.menu__item--danger {
    color: var(--danger);
}

.menu__item--danger:hover {
    background: var(--danger-soft);
    color: var(--danger);
}

@media (max-width: 1023px) {
    .topbar {
        padding: 0 var(--space-3);
    }

    .topbar__sidebar {
        display: inline-flex;
    }

    .topbar__title {
        font-size: var(--text-base);
    }

    .topbar__model {
        max-width: 140px;
    }
}
</style>
