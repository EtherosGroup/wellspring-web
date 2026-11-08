<script setup lang="ts">
/*
 * 输入区
 *
 * 自适应 textarea（最高 200px）、Enter 发送 / Shift+Enter 换行、IME 组合期不误发、
 * @ 文件补全、模型/推理/权限胶囊菜单、发送/插话/停止切换、草稿与键盘提示。
 * 触摸键盘用 enterkeyhint="send"，与桌面 Enter 行为一致。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"

import {
    actions,
    conversationModelLabel,
    permissionLabel,
    reasoningLabel,
    store,
} from "../../store"
import type { Permission, WorkspaceFileEntry } from "../../types"
import Icon from "../Icon.vue"
import PopMenu from "../layout/PopMenu.vue"

const TEXTAREA_MAX_HEIGHT = 200
const FILE_LIMIT = 8

const textarea = ref<HTMLTextAreaElement | null>(null)
const composing = ref(false)
const submitting = ref(false)

const modelMenuOpen = ref(false)
const reasoningMenuOpen = ref(false)
const permissionMenuOpen = ref(false)

const fileOpen = ref(false)
const fileLoading = ref(false)
const fileEntries = ref<WorkspaceFileEntry[]>([])
const fileIndex = ref(0)
const fileAnchor = ref(0)
const fileQuery = ref("")
const references = ref<string[]>([])

let searchTimer: number | null = null
let searchSeq = 0

const draft = computed(() => store.draft)

const charLimit = computed(() => store.limits?.maxMessageChars ?? 32000)

const canSend = computed(
    () => store.ready && !submitting.value && store.draft.trim() !== "" && store.draft.length <= charLimit.value,
)

const nearLimit = computed(() => store.draft.length > charLimit.value * 0.8)

const modelText = computed(() => conversationModelLabel(store.conversation))

const reasoningText = computed(
    () => `推理 ${reasoningLabel(store.conversation?.reasoning ?? store.models?.activeReasoning ?? null)}`,
)

const permissionText = computed(() =>
    permissionLabel(store.conversation?.permission ?? store.defaultPermission),
)

const providers = computed(() => store.models?.providers ?? [])

const reasoningLevels = computed(() => {
    const levels = store.models?.reasoningLevels ?? ["off", "low", "high", "max"]
    return levels.filter((level) => level !== "")
})

const PERMISSIONS: { value: Permission; label: string; hint: string }[] = [
    { value: "read-only", label: "只读", hint: "仅读取文件" },
    { value: "workspace-write", label: "工作区写入", hint: "可修改工作区文件" },
    { value: "danger-full-access", label: "完全访问", hint: "不受工作区限制" },
]

/* ------------------------------ 自适应高度 ------------------------------ */

function autoResize(): void {
    const element = textarea.value
    if (element === null) {
        return
    }
    element.style.height = "auto"
    element.style.height = `${Math.min(element.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`
}

watch(
    () => store.draft,
    () => {
        void nextTick(autoResize)
    },
)

watch(
    () => store.activeId,
    () => {
        references.value = []
        closeFile()
        void nextTick(autoResize)
    },
)

/* ------------------------------ 发送 / 插话 / 停止 ------------------------------ */

async function submit(): Promise<void> {
    const value = store.draft.trim()
    if (value === "" || submitting.value || store.ready !== true) {
        return
    }
    if (value.length > charLimit.value) {
        actions.toast(`消息超出 ${charLimit.value} 字上限`, "error")
        return
    }
    closeFile()
    submitting.value = true
    try {
        const refs = [...references.value]
        await actions.send(value, refs)
        if (store.draft.trim() === "") {
            references.value = []
        }
    } finally {
        submitting.value = false
        void nextTick(() => {
            autoResize()
            textarea.value?.focus()
        })
    }
}

function onKeydown(event: KeyboardEvent): void {
    if (fileOpen.value) {
        if (event.key === "ArrowDown") {
            event.preventDefault()
            fileIndex.value = (fileIndex.value + 1) % Math.max(fileEntries.value.length, 1)
            return
        }
        if (event.key === "ArrowUp") {
            event.preventDefault()
            fileIndex.value = (fileIndex.value - 1 + fileEntries.value.length) % Math.max(fileEntries.value.length, 1)
            return
        }
        if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault()
            pickFile(fileIndex.value)
            return
        }
        if (event.key === "Escape") {
            event.preventDefault()
            closeFile()
            return
        }
    }
    if (event.key !== "Enter" || event.shiftKey) {
        return
    }
    /* IME 组合期与组合刚结束的 Enter 属于上屏操作 */
    if (event.isComposing || composing.value) {
        return
    }
    event.preventDefault()
    void submit()
}

function onInput(event: Event): void {
    const element = event.target as HTMLTextAreaElement
    actions.setDraft(element.value)
    autoResize()
    detectAt()
}

/* ------------------------------ @ 文件补全 ------------------------------ */

function detectAt(): void {
    const element = textarea.value
    if (element === null) {
        return
    }
    const caret = element.selectionStart
    const before = element.value.slice(0, caret)
    const match = /(?:^|\s)@([^\s@]*)$/.exec(before)
    if (match === null) {
        closeFile()
        return
    }
    const query = match[1] ?? ""
    fileAnchor.value = caret - query.length - 1
    fileQuery.value = query
    fileOpen.value = true
    scheduleSearch(query)
}

function scheduleSearch(query: string): void {
    if (searchTimer !== null) {
        window.clearTimeout(searchTimer)
    }
    searchTimer = window.setTimeout(() => {
        searchTimer = null
        void runSearch(query)
    }, 150)
}

async function runSearch(query: string): Promise<void> {
    const seq = ++searchSeq
    fileLoading.value = true
    const entries = await actions.searchFiles(query)
    if (seq !== searchSeq) {
        return
    }
    fileEntries.value = entries.slice(0, FILE_LIMIT)
    fileIndex.value = 0
    fileLoading.value = false
}

function closeFile(): void {
    fileOpen.value = false
    fileEntries.value = []
    fileLoading.value = false
    fileQuery.value = ""
    searchSeq += 1
}

function pickFile(index: number): void {
    const entry = fileEntries.value[index]
    if (entry === undefined) {
        return
    }
    const element = textarea.value
    if (element === null) {
        closeFile()
        return
    }
    const caret = element.selectionStart
    const next = `${element.value.slice(0, fileAnchor.value)}@${entry.path} ${element.value.slice(caret)}`
    actions.setDraft(next)
    if (!references.value.includes(entry.path)) {
        references.value = [...references.value, entry.path]
    }
    closeFile()
    void nextTick(() => {
        const position = fileAnchor.value + entry.path.length + 2
        element.focus()
        element.setSelectionRange(position, position)
        autoResize()
    })
}

function removeReference(path: string): void {
    references.value = references.value.filter((item) => item !== path)
}

/* ------------------------------ 菜单选择 ------------------------------ */

function chooseModel(providerId: string, modelId: string): void {
    modelMenuOpen.value = false
    void actions.setModel({ provider: providerId, model: modelId })
}

function chooseReasoning(level: string): void {
    reasoningMenuOpen.value = false
    void actions.setModel({ reasoning: level })
}

function choosePermission(permission: Permission): void {
    permissionMenuOpen.value = false
    void actions.setPermission(permission)
}

function isModelActive(providerId: string, modelId: string): boolean {
    return (
        providerId === (store.conversation?.provider ?? store.models?.activeProvider) &&
        modelId === (store.conversation?.model ?? store.models?.activeModel)
    )
}

function isReasoningActive(level: string): boolean {
    return level === (store.conversation?.reasoning ?? store.models?.activeReasoning)
}

/* ------------------------------ 生命周期 ------------------------------ */

function focusComposer(): void {
    textarea.value?.focus()
}

function bindFocusEvent(): void {
    window.addEventListener("wellspring:focus-composer", focusComposer)
}

onMounted(() => {
    autoResize()
    bindFocusEvent()
})

onBeforeUnmount(() => {
    window.removeEventListener("wellspring:focus-composer", focusComposer)
    if (searchTimer !== null) {
        window.clearTimeout(searchTimer)
    }
})
</script>

<template>
    <div class="composer">
        <div class="composer__panel" :class="{ 'composer__panel--busy': store.streaming }">
            <div v-if="references.length > 0" class="composer__refs">
                <span v-for="path in references" :key="path" class="ref">
                    <Icon name="file" :size="12" />
                    <span class="ref__path" :title="path">{{ path }}</span>
                    <button
                        class="ref__remove"
                        type="button"
                        :aria-label="`移除引用 ${path}`"
                        @click="removeReference(path)"
                    >
                        <Icon name="close" :size="11" />
                    </button>
                </span>
            </div>

            <div class="composer__input-wrap">
                <textarea
                    ref="textarea"
                    class="composer__input"
                    :value="store.draft"
                    rows="1"
                    :placeholder="store.streaming ? '运行中，可输入插话…' : '给 Agent 发消息，@ 引用工作区文件'"
                    :aria-label="store.streaming ? '插话内容' : '消息内容'"
                    data-composer-input
                    enterkeyhint="send"
                    autocomplete="off"
                    spellcheck="false"
                    @input="onInput"
                    @keydown="onKeydown"
                    @compositionstart="composing = true"
                    @compositionend="composing = false"
                    @click="detectAt"
                    @blur="closeFile"
                />
                <div v-if="fileOpen" class="file-pop">
                    <p class="file-pop__label">
                        <Icon name="search" :size="12" />
                        {{ fileQuery === "" ? "引用工作区文件" : `搜索：${fileQuery}` }}
                    </p>
                    <p v-if="fileLoading" class="file-pop__empty">搜索中…</p>
                    <p v-else-if="fileEntries.length === 0" class="file-pop__empty">无匹配文件</p>
                    <button
                        v-for="(entry, index) in fileEntries"
                        :key="entry.path"
                        class="file-pop__item"
                        :class="{ 'file-pop__item--active': index === fileIndex }"
                        type="button"
                        role="option"
                        :aria-selected="index === fileIndex"
                        @mousedown.prevent="pickFile(index)"
                    >
                        <Icon :name="entry.type === 'directory' ? 'folder' : 'file'" :size="14" />
                        <span class="file-pop__name">{{ entry.name }}</span>
                        <span class="file-pop__path">{{ entry.path }}</span>
                    </button>
                    <p class="file-pop__hint">↑↓ 选择 · Enter 确认 · Esc 关闭</p>
                </div>
            </div>

            <div class="composer__footer">
                <div class="composer__pills">
                    <PopMenu
                        :open="modelMenuOpen"
                        placement="up"
                        label="选择模型"
                        :width="272"
                        @close="modelMenuOpen = false"
                    >
                        <button
                            class="pill composer__pill"
                            type="button"
                            aria-haspopup="menu"
                            :aria-expanded="modelMenuOpen"
                            :title="`模型：${modelText}`"
                            @click="modelMenuOpen = !modelMenuOpen"
                        >
                            <Icon name="cpu" :size="14" />
                            <span class="composer__pill-text">{{ modelText }}</span>
                        </button>
                        <template #menu>
                            <template v-if="providers.length === 0">
                                <p class="menu__empty">无可用模型</p>
                            </template>
                            <template v-for="provider in providers" :key="provider.id">
                                <p class="menu__label">
                                    {{ provider.name }}
                                    <span v-if="!provider.keyConfigured" class="menu__warn">未配置 Key</span>
                                </p>
                                <button
                                    v-for="modelId in provider.models"
                                    :key="`${provider.id}/${modelId}`"
                                    class="menu__item"
                                    type="button"
                                    role="menuitem"
                                    :aria-checked="isModelActive(provider.id, modelId)"
                                    @click="chooseModel(provider.id, modelId)"
                                >
                                    <span class="menu__model">{{ modelId }}</span>
                                </button>
                                <p v-if="provider.models.length === 0" class="menu__empty">无模型</p>
                            </template>
                        </template>
                    </PopMenu>

                    <PopMenu
                        :open="reasoningMenuOpen"
                        placement="up"
                        label="选择推理强度"
                        :width="180"
                        @close="reasoningMenuOpen = false"
                    >
                        <button
                            class="pill composer__pill"
                            type="button"
                            aria-haspopup="menu"
                            :aria-expanded="reasoningMenuOpen"
                            :title="`推理强度：${reasoningText}`"
                            @click="reasoningMenuOpen = !reasoningMenuOpen"
                        >
                            <Icon name="gauge" :size="14" />
                            <span class="composer__pill-text">{{ reasoningText }}</span>
                        </button>
                        <template #menu>
                            <p class="menu__label">推理强度</p>
                            <button
                                v-for="level in reasoningLevels"
                                :key="level"
                                class="menu__item"
                                type="button"
                                role="menuitem"
                                :aria-checked="isReasoningActive(level)"
                                @click="chooseReasoning(level)"
                            >
                                {{ reasoningLabel(level) }}
                            </button>
                        </template>
                    </PopMenu>

                    <PopMenu
                        :open="permissionMenuOpen"
                        placement="up"
                        label="选择权限"
                        :width="248"
                        @close="permissionMenuOpen = false"
                    >
                        <button
                            class="pill composer__pill"
                            type="button"
                            aria-haspopup="menu"
                            :aria-expanded="permissionMenuOpen"
                            :title="`权限：${permissionText}`"
                            @click="permissionMenuOpen = !permissionMenuOpen"
                        >
                            <Icon name="shield" :size="14" />
                            <span class="composer__pill-text">{{ permissionText }}</span>
                        </button>
                        <template #menu>
                            <p class="menu__label">权限</p>
                            <button
                                v-for="item in PERMISSIONS"
                                :key="item.value"
                                class="menu__item menu__item--stack"
                                type="button"
                                role="menuitem"
                                :aria-checked="(store.conversation?.permission ?? store.defaultPermission) === item.value"
                                @click="choosePermission(item.value)"
                            >
                                <span class="menu__permission">
                                    <span>{{ item.label }}</span>
                                    <span class="menu__hint">{{ item.hint }}</span>
                                </span>
                            </button>
                        </template>
                    </PopMenu>
                </div>

                <div class="composer__actions">
                    <button
                        v-if="store.streaming"
                        class="composer__icon-btn"
                        type="button"
                        aria-label="停止本轮"
                        title="停止本轮"
                        @click="actions.stop()"
                    >
                        <Icon name="stop" :size="16" />
                    </button>
                    <button
                        class="composer__send"
                        type="button"
                        :disabled="!canSend"
                        :aria-label="store.streaming ? '插话' : '发送'"
                        :title="store.streaming ? '插话（Enter）' : '发送（Enter）'"
                        @click="submit"
                    >
                        <Icon :name="store.streaming ? 'message' : 'send'" :size="17" />
                    </button>
                </div>
            </div>

            <div class="composer__hints">
                <span class="composer__hint">
                    <span class="kbd">Enter</span> 发送
                    <span class="kbd">Shift</span><span class="kbd">Enter</span> 换行
                    <span class="composer__hint-item">@ 引用文件</span>
                </span>
                <span
                    v-if="store.draft.length > 0"
                    class="composer__hint composer__hint--count"
                    :class="{ 'composer__hint--warn': nearLimit }"
                    :aria-label="`已输入 ${store.draft.length} 字`"
                >
                    {{ store.draft.length }}<template v-if="nearLimit"> / {{ charLimit }}</template>
                </span>
            </div>
        </div>
    </div>
</template>

<style scoped>
.composer {
    padding: var(--space-2) var(--space-5) var(--space-4);
    background: linear-gradient(180deg, transparent, var(--bg) 24%);
}

.composer__panel {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    max-width: var(--content-width);
    margin: 0 auto;
    padding: 10px 10px 8px 14px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: var(--shadow-sm);
    transition:
        border-color var(--dur-fast) var(--ease),
        box-shadow var(--dur-fast) var(--ease);
}

.composer__panel:focus-within {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--hairline));
    box-shadow: var(--ring);
}

.composer__panel--busy {
    border-color: color-mix(in srgb, var(--accent) 30%, var(--hairline));
}

.composer__refs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding-right: 4px;
}

.ref {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 100%;
    height: 24px;
    padding: 0 4px 0 8px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-full);
    background: var(--surface-2);
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
}

.ref__path {
    overflow: hidden;
    max-width: 220px;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ref__remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    color: var(--faint);
}

.ref__remove:hover {
    background: var(--surface-3);
    color: var(--ink);
}

.composer__input-wrap {
    position: relative;
}

.composer__input {
    display: block;
    width: 100%;
    max-height: 200px;
    min-height: 24px;
    padding: 2px 4px 2px 0;
    overflow-y: auto;
    border: none;
    outline: none;
    background: transparent;
    color: var(--ink);
    font-family: var(--font-sans);
    font-size: var(--text-md);
    line-height: 1.55;
    resize: none;
}

.composer__input::placeholder {
    color: var(--faint);
}

/* 文件补全 */
.file-pop {
    position: absolute;
    bottom: calc(100% + 10px);
    left: -6px;
    z-index: 55;
    width: min(420px, calc(100vw - 52px));
    padding: 6px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-md);
    background: var(--surface-raise);
    box-shadow: var(--shadow-md);
    animation: menu-in var(--dur-fast) var(--ease);
}

.file-pop__label {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 4px 8px 6px;
    color: var(--faint);
    font-size: var(--text-2xs);
    letter-spacing: 0.04em;
}

.file-pop__empty {
    padding: 8px;
    color: var(--faint);
    font-size: var(--text-sm);
}

.file-pop__item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    min-height: 32px;
    padding: 5px 8px;
    border-radius: var(--radius-xs);
    color: var(--ink-2);
    font-size: var(--text-sm);
    text-align: left;
}

.file-pop__item:hover,
.file-pop__item--active {
    background: var(--surface-2);
    color: var(--ink);
}

.file-pop__name {
    flex: none;
    max-width: 50%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.file-pop__path {
    overflow: hidden;
    color: var(--faint);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.file-pop__hint {
    padding: 6px 8px 2px;
    color: var(--faint);
    font-size: var(--text-2xs);
}

.composer__footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
}

.composer__pills {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    flex-wrap: wrap;
}

.composer__pill {
    height: 28px;
    padding: 0 9px;
    font-size: var(--text-2xs);
}

.composer__pill-text {
    overflow: hidden;
    max-width: 150px;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.composer__actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: none;
}

.composer__icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: var(--radius-full);
    border: 1px solid var(--hairline);
    color: var(--muted);
    transition:
        background var(--dur-fast) var(--ease),
        color var(--dur-fast) var(--ease);
}

.composer__icon-btn:hover {
    background: var(--surface-2);
    color: var(--ink);
}

.composer__send {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: var(--radius-full);
    background: var(--accent);
    color: #fffdf8;
    transition:
        background var(--dur-fast) var(--ease),
        transform var(--dur-fast) var(--ease),
        opacity var(--dur-fast) var(--ease);
}

.composer__send:hover:not(:disabled) {
    background: var(--accent-strong);
}

.composer__send:active:not(:disabled) {
    transform: scale(0.96);
}

.composer__send:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}

.composer__hints {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: 0 2px 2px;
    color: var(--faint);
    font-size: var(--text-2xs);
}

.composer__hint {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
}

.composer__hint-item {
    display: inline-flex;
    align-items: center;
    gap: 3px;
}

.composer__hint--count {
    font-family: var(--font-mono);
}

.composer__hint--warn {
    color: var(--warn);
}

.menu__empty {
    padding: 6px 10px;
    color: var(--faint);
    font-size: var(--text-sm);
}

.menu__warn {
    margin-left: auto;
    color: var(--warn);
    font-size: var(--text-2xs);
    letter-spacing: 0;
    text-transform: none;
}

.menu__model {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
}

.menu__item--stack {
    align-items: flex-start;
}

.menu__permission {
    display: flex;
    flex-direction: column;
    gap: 1px;
}

.menu__hint {
    color: var(--faint);
    font-size: var(--text-2xs);
}

.menu__label {
    display: flex;
    align-items: center;
    justify-content: space-between;
}

@media (max-width: 640px) {
    .composer {
        padding: var(--space-2) var(--space-3) calc(var(--space-3) + env(safe-area-inset-bottom, 0px));
    }

    .composer__panel {
        padding: 8px 8px 6px 12px;
        border-radius: var(--radius-md);
    }

    .composer__pill-text {
        max-width: 96px;
    }

    .composer__hints {
        display: none;
    }
}
</style>
