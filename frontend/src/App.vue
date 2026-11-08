<script setup lang="ts">
/*
 * 应用外壳：三栏（索引 / 稿纸 / 上下文）、响应式抽屉、全局层
 *
 * 初始化顺序：bootstrap → 若 hash 指定会话则打开 → 哈希跟随 activeId。
 * 窄屏下侧栏与上下文面板以抽屉呈现，遮罩与 Esc 关闭。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"

import { actions, store } from "./store"
import ChatThread from "./components/chat/ChatThread.vue"
import Composer from "./components/composer/Composer.vue"
import Icon from "./components/Icon.vue"
import Inspector from "./components/layout/Inspector.vue"
import SettingsSheet from "./components/settings/SettingsSheet.vue"
import Sidebar from "./components/layout/Sidebar.vue"
import ToastStack from "./components/layout/ToastStack.vue"
import TopBar from "./components/layout/TopBar.vue"

const drawerOpen = computed(() => store.sidebarOpen || store.inspectorOpen)

/* 窄屏断点：进入窄屏收起抽屉，离开时按默认策略恢复 */
const narrowQuery = window.matchMedia("(max-width: 1023px)")
const isNarrow = ref(narrowQuery.matches)

function hashConversationId(): string | null {
    const match = /^#\/c\/([a-z0-9]+)/i.exec(window.location.hash)
    return match === null ? null : (match[1] ?? null)
}

function syncHash(): void {
    const target = store.activeId === null ? "#/" : `#/c/${store.activeId}`
    if (window.location.hash !== target) {
        window.history.replaceState(null, "", target)
    }
}

function onHashChange(): void {
    const id = hashConversationId()
    if (id !== null && id !== store.activeId) {
        void actions.openConversation(id)
    }
}

function closeDrawers(): void {
    actions.toggleSidebar(false)
    actions.toggleInspector(false)
}

function hasDialog(): boolean {
    return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null
}

function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || event.defaultPrevented || hasDialog()) {
        return
    }
    if (store.sidebarOpen || store.inspectorOpen) {
        closeDrawers()
    }
}

function onLayoutChange(event: MediaQueryListEvent): void {
    isNarrow.value = event.matches
    actions.syncLayoutWidth(event.matches)
}

watch(
    () => store.activeId,
    () => {
        syncHash()
    },
)

onMounted(() => {
    window.addEventListener("hashchange", onHashChange)
    window.addEventListener("keydown", onKeydown)
    narrowQuery.addEventListener("change", onLayoutChange)
    actions.syncLayoutWidth(narrowQuery.matches)
    void (async () => {
        await actions.bootstrap()
        const id = hashConversationId()
        if (id !== null && id !== store.activeId) {
            await actions.openConversation(id)
        }
        syncHash()
    })()
})

onBeforeUnmount(() => {
    window.removeEventListener("hashchange", onHashChange)
    window.removeEventListener("keydown", onKeydown)
    narrowQuery.removeEventListener("change", onLayoutChange)
})
</script>

<template>
    <div v-if="!store.ready" class="boot">
        <span class="boot__mark">
            <Icon name="spring" :size="22" />
            Wellspring
        </span>
        <span class="spinner boot__spinner" aria-hidden="true" />
        <p class="boot__hint" role="status">界面初始化中</p>
    </div>

    <div v-else-if="store.error !== null" class="boot boot--error">
        <span class="boot__mark">
            <Icon name="spring" :size="22" />
            Wellspring
        </span>
        <p class="boot__error">
            <Icon name="alert-circle" :size="16" />
            {{ store.error }}
        </p>
        <button class="btn btn--primary" type="button" @click="actions.bootstrap()">重试</button>
    </div>

    <div v-else class="app" :class="{ 'app--inspector': store.inspectorOpen }">
        <Sidebar />
        <main class="app__main">
            <TopBar />
            <div class="app__stage">
                <ChatThread />
            </div>
            <Composer />
        </main>
        <Inspector />
        <div v-if="drawerOpen && isNarrow" class="app-backdrop" aria-hidden="true" @click="closeDrawers" />
        <SettingsSheet />
        <ToastStack />
    </div>
</template>

<style scoped>
.boot {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    height: 100dvh;
    padding: var(--space-6);
    background: var(--bg);
    text-align: center;
}

.boot__mark {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--accent);
    font-family: var(--font-serif);
    font-size: var(--text-2xl);
    font-weight: 600;
    letter-spacing: 0.01em;
}

.boot__spinner {
    color: var(--accent);
}

.boot__hint {
    color: var(--faint);
    font-size: var(--text-sm);
}

.boot__error {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    max-width: 480px;
    color: var(--danger);
    font-size: var(--text-sm);
    line-height: 1.5;
}
</style>
