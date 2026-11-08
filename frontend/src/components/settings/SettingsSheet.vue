<script setup lang="ts">
/*
 * 设置面板
 *
 * 主题、默认模型/推理（宿主全局默认）、默认权限、工作区管理、关于。
 * 桌面居中对话框，窄屏底部 sheet；Esc 关闭，Tab 焦点限制在面板内。
 */
import { computed, nextTick, ref, watch } from "vue"

import { actions, permissionLabel, reasoningLabel, store, themeLabel, type AppState } from "../../store"
import type { Permission, ThemePref, Workspace } from "../../types"
import Icon from "../Icon.vue"

const panel = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
const providerId = ref("")
const modelId = ref("")
const reasoning = ref("")
const rootInput = ref("")
const addingWorkspace = ref(false)

const THEMES: { value: ThemePref; label: string; icon: string }[] = [
    { value: "system", label: "跟随系统", icon: "monitor" },
    { value: "light", label: "浅色", icon: "sun" },
    { value: "dark", label: "深色", icon: "moon" },
]

const PERMISSIONS: { value: Permission; label: string; hint: string }[] = [
    { value: "read-only", label: "只读", hint: "仅读取文件" },
    { value: "workspace-write", label: "工作区写入", hint: "可修改工作区文件" },
    { value: "danger-full-access", label: "完全访问", hint: "不受工作区限制" },
]

const models = computed(() => store.models)
const providers = computed(() => models.value?.providers ?? [])
const currentProvider = computed(() => providers.value.find((item) => item.id === providerId.value) ?? null)
const modelOptions = computed(() => currentProvider.value?.models ?? [])
const reasoningLevels = computed(() => models.value?.reasoningLevels ?? [])

const limits = computed<AppState["limits"]>(() => store.limits)

watch(
    () => store.settingsOpen,
    (open) => {
        if (!open) {
            return
        }
        syncModelFields()
        void nextTick(() => closeButton.value?.focus())
    },
    { immediate: true },
)

watch(
    () => models.value,
    () => {
        if (store.settingsOpen) {
            syncModelFields()
        }
    },
)

function syncModelFields(): void {
    const current = models.value
    if (current === null) {
        return
    }
    providerId.value = current.activeProvider
    modelId.value = current.activeModel ?? ""
    reasoning.value = current.activeReasoning
}

function onProviderChange(): void {
    const provider = providers.value.find((item) => item.id === providerId.value)
    modelId.value = provider?.defaultModel ?? provider?.models[0] ?? ""
    reasoning.value = reasoning.value === "" ? (models.value?.activeReasoning ?? "") : reasoning.value
    void applyModel()
}

function onModelChange(): void {
    void applyModel()
}

function onReasoningChange(): void {
    void applyModel()
}

async function applyModel(): Promise<void> {
    if (models.value === null || providerId.value === "") {
        return
    }
    await actions.setActiveModel({
        provider: providerId.value,
        model: modelId.value === "" ? null : modelId.value,
        reasoning: reasoning.value === "" ? null : reasoning.value,
    })
}

async function addByPath(): Promise<void> {
    const root = rootInput.value.trim()
    if (root === "" || addingWorkspace.value) {
        return
    }
    addingWorkspace.value = true
    try {
        await actions.addWorkspace({ root })
        rootInput.value = ""
    } finally {
        addingWorkspace.value = false
    }
}

function pickWorkspace(): void {
    void actions.addWorkspace({ pick: true })
}

function useWorkspace(workspace: Workspace): void {
    void actions.setWorkspace(workspace.id)
}

function removeWorkspace(workspace: Workspace): void {
    void actions.removeWorkspace(workspace.id)
}

function close(): void {
    actions.openSettings(false)
}

function onPanelKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
        event.stopPropagation()
        close()
        return
    }
    if (event.key !== "Tab" || panel.value === null) {
        return
    }
    const focusables = Array.from(
        panel.value.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
    )
    if (focusables.length === 0) {
        return
    }
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (first === undefined || last === undefined) {
        return
    }
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
    }
}

function healthUrl(): string {
    return "/__web/health"
}
</script>

<template>
    <Teleport to="body">
        <div v-if="store.settingsOpen" class="sheet-backdrop" @click.self="close">
            <div
                ref="panel"
                class="settings"
                role="dialog"
                aria-modal="true"
                aria-labelledby="settings-title"
                @keydown="onPanelKeydown"
            >
                <header class="settings__head">
                    <h2 id="settings-title" class="settings__title">设置</h2>
                    <button ref="closeButton" class="icon-btn" type="button" aria-label="关闭设置" @click="close">
                        <Icon name="close" :size="17" />
                    </button>
                </header>

                <div class="settings__body scroll">
                    <section class="settings__section">
                        <h3 class="settings__label">外观</h3>
                        <div class="seg" role="group" aria-label="主题">
                            <button
                                v-for="item in THEMES"
                                :key="item.value"
                                class="seg__item"
                                type="button"
                                :aria-pressed="store.theme === item.value"
                                :title="`主题：${themeLabel(item.value)}`"
                                @click="actions.setTheme(item.value)"
                            >
                                <Icon :name="item.icon" :size="15" />
                                {{ item.label }}
                            </button>
                        </div>
                    </section>

                    <section class="settings__section">
                        <h3 class="settings__label">默认模型</h3>
                        <p class="settings__hint">新会话沿用宿主默认；当前会话在输入区单独选择。</p>
                        <div v-if="models === null" class="settings__empty">
                            <Icon name="alert-circle" :size="15" />
                            宿主未提供模型能力
                        </div>
                        <template v-else>
                            <div class="settings__grid">
                                <div class="field">
                                    <label for="settings-provider">供应商</label>
                                    <select
                                        id="settings-provider"
                                        class="input"
                                        :value="providerId"
                                        @change="providerId = ($event.target as HTMLSelectElement).value; onProviderChange()"
                                    >
                                        <option v-for="provider in providers" :key="provider.id" :value="provider.id">
                                            {{ provider.name }}{{ provider.keyConfigured ? "" : "（未配置 Key）" }}
                                        </option>
                                    </select>
                                </div>
                                <div class="field">
                                    <label for="settings-model">模型</label>
                                    <select
                                        id="settings-model"
                                        class="input"
                                        :value="modelId"
                                        @change="modelId = ($event.target as HTMLSelectElement).value; onModelChange()"
                                    >
                                        <option v-for="item in modelOptions" :key="item" :value="item">{{ item }}</option>
                                        <option v-if="modelOptions.length === 0" value="">无可用模型</option>
                                    </select>
                                </div>
                                <div class="field">
                                    <label for="settings-reasoning">推理强度</label>
                                    <select
                                        id="settings-reasoning"
                                        class="input"
                                        :value="reasoning"
                                        @change="reasoning = ($event.target as HTMLSelectElement).value; onReasoningChange()"
                                    >
                                        <option v-for="level in reasoningLevels" :key="level" :value="level">
                                            {{ reasoningLabel(level) }}
                                        </option>
                                    </select>
                                </div>
                            </div>
                        </template>
                    </section>

                    <section class="settings__section">
                        <h3 class="settings__label">默认权限</h3>
                        <p class="settings__hint">新建会话沿用；当前会话权限在输入区选择。</p>
                        <div class="choices" role="radiogroup" aria-label="默认权限">
                            <button
                                v-for="item in PERMISSIONS"
                                :key="item.value"
                                class="choice"
                                type="button"
                                role="radio"
                                :aria-checked="store.defaultPermission === item.value"
                                @click="actions.setDefaultPermission(item.value)"
                            >
                                <span class="choice__dot" aria-hidden="true" />
                                <span class="choice__body">
                                    <span class="choice__label">{{ item.label }}</span>
                                    <span class="choice__hint">{{ item.hint }}</span>
                                </span>
                            </button>
                        </div>
                        <p class="settings__hint">
                            当前会话：{{ permissionLabel(store.conversation?.permission ?? store.defaultPermission) }}
                        </p>
                    </section>

                    <section class="settings__section">
                        <h3 class="settings__label">工作区</h3>
                        <ul class="workspaces">
                            <li v-for="workspace in store.workspaces" :key="workspace.id" class="workspaces__item">
                                <button
                                    class="workspaces__main"
                                    type="button"
                                    :title="`设为默认工作区：${workspace.root}`"
                                    @click="useWorkspace(workspace)"
                                >
                                    <Icon name="folder" :size="15" class="workspaces__icon" />
                                    <span class="workspaces__body">
                                        <span class="workspaces__name">
                                            {{ workspace.name }}
                                            <span v-if="store.workspaceId === workspace.id" class="badge badge--accent">默认</span>
                                        </span>
                                        <span class="workspaces__path">{{ workspace.root }}</span>
                                    </span>
                                </button>
                                <button
                                    class="icon-btn icon-btn--sm"
                                    type="button"
                                    :aria-label="`移除工作区 ${workspace.name}`"
                                    @click="removeWorkspace(workspace)"
                                >
                                    <Icon name="trash" :size="14" />
                                </button>
                            </li>
                            <li v-if="store.workspaces.length === 0" class="workspaces__empty">暂无工作区</li>
                        </ul>
                        <div class="workspaces__add">
                            <button class="btn btn--sm" type="button" @click="pickWorkspace">
                                <Icon name="folder" :size="14" />
                                选择目录…
                            </button>
                            <form class="workspaces__path-form" @submit.prevent="addByPath">
                                <label class="sr-only" for="settings-root">工作区路径</label>
                                <input
                                    id="settings-root"
                                    v-model="rootInput"
                                    class="input input--sm"
                                    placeholder="或输入绝对路径"
                                    autocomplete="off"
                                    spellcheck="false"
                                />
                                <button
                                    class="btn btn--sm"
                                    type="submit"
                                    :disabled="rootInput.trim() === '' || addingWorkspace"
                                >
                                    添加
                                </button>
                            </form>
                        </div>
                    </section>

                    <section class="settings__section settings__section--last">
                        <h3 class="settings__label">关于</h3>
                        <dl class="about">
                            <div class="about__row">
                                <dt>版本</dt>
                                <dd>{{ store.version || "—" }}</dd>
                            </div>
                            <div class="about__row">
                                <dt>宿主</dt>
                                <dd>
                                    {{ store.host?.status ?? "—" }} · {{ store.host?.platform ?? "—" }}/{{
                                        store.host?.arch ?? "—"
                                    }}
                                </dd>
                            </div>
                            <div class="about__row">
                                <dt>Node</dt>
                                <dd>{{ store.host?.node ?? "—" }}</dd>
                            </div>
                            <div class="about__row">
                                <dt>登录用户</dt>
                                <dd>{{ store.user ?? "未登录" }}</dd>
                            </div>
                            <div class="about__row">
                                <dt>会话数</dt>
                                <dd>
                                    {{ store.conversations.length }}
                                    <template v-if="limits !== null"> / {{ limits.maxConversations }}</template>
                                </dd>
                            </div>
                            <div class="about__row">
                                <dt>健康检查</dt>
                                <dd>
                                    <a :href="healthUrl()" target="_blank" rel="noopener noreferrer">
                                        /__web/health
                                        <Icon name="external" :size="12" />
                                    </a>
                                </dd>
                            </div>
                        </dl>
                    </section>
                </div>
            </div>
        </div>
    </Teleport>
</template>

<style scoped>
.settings {
    position: fixed;
    top: 50%;
    left: 50%;
    z-index: 70;
    display: flex;
    flex-direction: column;
    width: min(620px, calc(100vw - 32px));
    max-height: min(82vh, 780px);
    overflow: hidden;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: var(--shadow-lg);
    transform: translate(-50%, -50%);
    animation: settings-in var(--dur) var(--ease);
}

@keyframes settings-in {
    from {
        opacity: 0;
        transform: translate(-50%, calc(-50% + 10px));
    }
    to {
        opacity: 1;
        transform: translate(-50%, -50%);
    }
}

.settings__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4) var(--space-4) var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--hairline);
}

.settings__title {
    font-family: var(--font-serif);
    font-size: var(--text-xl);
    font-weight: 600;
}

.settings__body {
    padding: var(--space-2) var(--space-5) var(--space-6);
}

.settings__section {
    padding: var(--space-4) 0;
    border-bottom: 1px solid var(--hairline);
}

.settings__section--last {
    border-bottom: none;
}

.settings__label {
    margin-bottom: var(--space-2);
    color: var(--faint);
    font-size: var(--text-2xs);
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
}

.settings__hint {
    margin-bottom: var(--space-2);
    color: var(--faint);
    font-size: var(--text-xs);
}

.settings__empty {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--muted);
    font-size: var(--text-sm);
}

.settings__grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: var(--space-3);
}

.seg {
    display: inline-flex;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-full);
    background: var(--surface-2);
}

.seg__item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    height: 32px;
    padding: 0 12px;
    border-radius: var(--radius-full);
    color: var(--muted);
    font-size: var(--text-sm);
    transition:
        background var(--dur-fast) var(--ease),
        color var(--dur-fast) var(--ease);
}

.seg__item:hover {
    color: var(--ink);
}

.seg__item[aria-pressed="true"] {
    background: var(--surface);
    box-shadow: var(--shadow-sm);
    color: var(--ink);
}

.choices {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.choice {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: 8px 10px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    text-align: left;
    transition:
        background var(--dur-fast) var(--ease),
        border-color var(--dur-fast) var(--ease);
}

.choice:hover {
    background: var(--surface-2);
}

.choice[aria-checked="true"] {
    border-color: var(--hairline);
    background: var(--accent-softer);
}

.choice__dot {
    width: 12px;
    height: 12px;
    flex: none;
    margin-top: 3px;
    border: 1px solid var(--hairline-strong);
    border-radius: 50%;
    background: var(--surface);
}

.choice[aria-checked="true"] .choice__dot {
    border: 3px solid var(--accent);
    background: var(--surface);
}

.choice__body {
    display: flex;
    flex-direction: column;
    gap: 1px;
}

.choice__label {
    color: var(--ink-2);
    font-size: var(--text-sm);
}

.choice__hint {
    color: var(--faint);
    font-size: var(--text-2xs);
}

.workspaces {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0 0 var(--space-3);
    padding: 0;
    list-style: none;
}

.workspaces__item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    border-radius: var(--radius-sm);
    padding-right: 4px;
}

.workspaces__item:hover {
    background: var(--surface-2);
}

.workspaces__main {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: 1;
    min-width: 0;
    padding: 8px 10px;
    text-align: left;
}

.workspaces__icon {
    flex: none;
    color: var(--muted);
}

.workspaces__body {
    display: flex;
    flex-direction: column;
    min-width: 0;
}

.workspaces__name {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--ink-2);
    font-size: var(--text-sm);
}

.workspaces__path {
    overflow: hidden;
    color: var(--faint);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.workspaces__empty {
    padding: 8px 10px;
    color: var(--faint);
    font-size: var(--text-sm);
}

.workspaces__add {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
}

.workspaces__path-form {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 220px;
}

.input--sm {
    height: 30px;
    padding: 4px 9px;
    font-size: var(--text-sm);
}

.about {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin: 0;
}

.about__row {
    display: flex;
    align-items: baseline;
    gap: var(--space-4);
    padding: 5px 0;
}

.about__row dt {
    width: 76px;
    flex: none;
    color: var(--faint);
    font-size: var(--text-xs);
}

.about__row dd {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 0;
    color: var(--ink-2);
    font-size: var(--text-sm);
}

.about__row a {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
}

@media (max-width: 640px) {
    .settings {
        top: auto;
        bottom: 0;
        left: 0;
        width: 100%;
        max-height: 88dvh;
        border-radius: var(--radius-xl) var(--radius-xl) 0 0;
        transform: none;
        animation: sheet-up var(--dur) var(--ease);
    }

    @keyframes sheet-up {
        from {
            opacity: 0;
            transform: translateY(24px);
        }
        to {
            opacity: 1;
            transform: none;
        }
    }

    .settings__body {
        padding: var(--space-2) var(--space-4) calc(var(--space-6) + env(safe-area-inset-bottom, 0px));
    }

    .seg__item {
        flex: 1;
        justify-content: center;
        padding: 0 8px;
    }
}
</style>
