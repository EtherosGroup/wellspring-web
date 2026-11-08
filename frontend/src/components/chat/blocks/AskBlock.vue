<script setup lang="ts">
/*
 * 提问卡：单选（「（推荐）」结尾转徽标）+ 自定义回答 + 跳过
 * 回答后展示答案；消息已结束仍未答时显示未回答
 */

import { computed, ref, useId } from "vue"

import Icon from "../../Icon.vue"
import type { AskBlock } from "../../../types"

const props = withDefaults(defineProps<{ block: AskBlock; disabled?: boolean }>(), { disabled: false })

const emit = defineEmits<{
    answer: [askId: string, answer: string]
    skip: [askId: string]
}>()

const groupName = useId()
const selected = ref<string | null>(null)
const custom = ref("")

interface OptionView {
    value: string
    label: string
    recommended: boolean
}

const options = computed<OptionView[]>(() =>
    props.block.options.map((value) => {
        const recommended = /[（(]\s*推荐\s*[）)]\s*$/.test(value)
        const label = value.replace(/[（(]\s*推荐\s*[）)]\s*$/, "").trim()
        return { value, label: label === "" ? value : label, recommended }
    }),
)

const answered = computed(() => props.block.answer !== null)
const canSubmit = computed(
    () =>
        !answered.value &&
        !props.disabled &&
        (selected.value !== null || custom.value.trim() !== ""),
)

function submit(): void {
    if (!canSubmit.value) {
        return
    }
    const value = selected.value ?? custom.value.trim()
    if (value === "") {
        return
    }
    emit("answer", props.block.askId, value)
}

function skip(): void {
    if (answered.value || props.disabled) {
        return
    }
    emit("skip", props.block.askId)
}

function onEnter(event: KeyboardEvent): void {
    if (event.isComposing) {
        return
    }
    submit()
}
</script>

<template>
    <div class="ask">
        <div class="ask__head">
            <Icon class="ask__icon" name="message" :size="15" />
            <p class="ask__question">{{ block.question }}</p>
        </div>

        <template v-if="!answered && !disabled">
            <div v-if="options.length > 0" class="ask__options" role="radiogroup" :aria-label="block.question">
                <label
                    v-for="option in options"
                    :key="option.value"
                    class="ask__option"
                    :class="{ 'ask__option--checked': selected === option.value }"
                >
                    <input
                        v-model="selected"
                        class="ask__radio"
                        type="radio"
                        :name="groupName"
                        :value="option.value"
                    />
                    <span class="ask__mark" aria-hidden="true" />
                    <span class="ask__option-text">{{ option.label }}</span>
                    <span v-if="option.recommended" class="badge badge--accent">推荐</span>
                </label>
            </div>

            <label class="ask__custom">
                <span class="sr-only">自定义回答</span>
                <input
                    v-model="custom"
                    class="input ask__input"
                    type="text"
                    placeholder="自定义回答"
                    autocomplete="off"
                    @keydown.enter="onEnter"
                />
            </label>

            <div class="ask__actions">
                <button type="button" class="btn btn--primary btn--sm" :disabled="!canSubmit" @click="submit">
                    提交
                </button>
                <button type="button" class="btn btn--ghost btn--sm" @click="skip">跳过</button>
            </div>
        </template>

        <div v-else-if="answered" class="ask__result">
            <Icon :name="block.answer === '' ? 'enter' : 'check'" :size="14" />
            <span class="ask__result-label">{{ block.answer === "" ? "已跳过" : "已回答" }}</span>
            <span v-if="block.answer !== ''" class="ask__answer">{{ block.answer }}</span>
        </div>

        <div v-else class="ask__result ask__result--muted">
            <Icon name="clock" :size="14" />
            <span class="ask__result-label">未回答</span>
        </div>
    </div>
</template>

<style scoped>
.ask {
    margin: 14px 0;
    padding: 13px 15px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-md);
    background: var(--surface);
    box-shadow: var(--shadow-sm);
}

.ask__head {
    display: flex;
    align-items: flex-start;
    gap: 8px;
}

.ask__icon {
    margin-top: 3px;
    flex: none;
    color: var(--accent);
}

.ask__question {
    color: var(--ink);
    font-size: var(--text-md);
    font-weight: 550;
    line-height: 1.55;
    overflow-wrap: anywhere;
}

.ask__options {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 10px 0 6px;
}

.ask__option {
    position: relative;
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 34px;
    padding: 5px 8px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--ink-2);
    font-size: var(--text-base);
    cursor: pointer;
    transition:
        background var(--dur-fast) var(--ease),
        border-color var(--dur-fast) var(--ease);
}

.ask__option:hover {
    background: var(--surface-2);
}

.ask__option--checked {
    border-color: color-mix(in srgb, var(--accent) 40%, var(--hairline));
    background: var(--accent-softer);
}

.ask__radio {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
}

.ask__mark {
    flex: none;
    width: 14px;
    height: 14px;
    border: 1px solid var(--hairline-strong);
    border-radius: 50%;
    background: var(--surface);
    transition: border-color var(--dur-fast) var(--ease);
}

.ask__option--checked .ask__mark {
    border: 4px solid var(--accent);
    background: var(--surface);
}

.ask__radio:focus-visible + .ask__mark {
    box-shadow: var(--ring);
}

.ask__option-text {
    min-width: 0;
    flex: 1;
    overflow-wrap: anywhere;
}

.ask__custom {
    display: block;
    margin: 4px 0 10px;
}

.ask__input {
    min-height: 34px;
}

.ask__actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
}

.ask__result {
    display: flex;
    align-items: baseline;
    gap: 7px;
    margin-top: 10px;
    padding-top: 9px;
    border-top: 1px solid var(--hairline);
    color: var(--ok);
    font-size: var(--text-sm);
}

.ask__result-label {
    flex: none;
    font-weight: 500;
}

.ask__answer {
    min-width: 0;
    color: var(--ink-2);
    overflow-wrap: anywhere;
}

.ask__result--muted {
    color: var(--faint);
}

@media (max-width: 640px) {
    .ask {
        padding: 12px 12px;
    }
}
</style>
