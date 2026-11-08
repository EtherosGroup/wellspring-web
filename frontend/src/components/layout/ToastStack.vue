<script setup lang="ts">
/*
 * 全局 Toast 堆叠
 *
 * 读取 store.toasts；info/success/error 对应不同图标与色带。
 * aria-live 区域播报，单条可手动关闭。
 */
import { dismissToast, store } from "../../store"
import type { ToastTone } from "../../types"
import Icon from "../Icon.vue"

function toneIcon(tone: ToastTone): string {
    switch (tone) {
        case "success":
            return "check"
        case "error":
            return "alert-circle"
        default:
            return "info"
    }
}
</script>

<template>
    <div class="toasts" role="status" aria-live="polite" aria-atomic="false">
        <TransitionGroup name="toast" tag="div" class="toasts__list">
            <div v-for="item in store.toasts" :key="item.id" class="toast" :class="`toast--${item.tone}`">
                <Icon :name="toneIcon(item.tone)" :size="16" class="toast__icon" />
                <span class="toast__text">{{ item.text }}</span>
                <button class="toast__close" type="button" aria-label="关闭提示" @click="dismissToast(item.id)">
                    <Icon name="close" :size="14" />
                </button>
            </div>
        </TransitionGroup>
    </div>
</template>

<style scoped>
.toasts {
    position: fixed;
    z-index: 80;
    right: var(--space-6);
    bottom: var(--space-6);
    pointer-events: none;
}

.toasts__list {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-2);
}

.toast {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    max-width: min(360px, calc(100vw - 32px));
    padding: 10px 10px 10px 12px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-md);
    background: var(--surface-raise);
    box-shadow: var(--shadow-md);
    color: var(--ink-2);
    font-size: var(--text-sm);
    pointer-events: auto;
}

.toast--success {
    border-color: color-mix(in srgb, var(--ok) 35%, var(--hairline));
}

.toast--error {
    border-color: color-mix(in srgb, var(--danger) 35%, var(--hairline));
}

.toast__icon {
    color: var(--muted);
}

.toast--success .toast__icon {
    color: var(--ok);
}

.toast--error .toast__icon {
    color: var(--danger);
}

.toast__text {
    flex: 1;
    min-width: 0;
    line-height: 1.45;
}

.toast__close {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: var(--radius-xs);
    color: var(--faint);
}

.toast__close:hover {
    background: var(--surface-2);
    color: var(--ink);
}

.toast-enter-active,
.toast-leave-active {
    transition:
        opacity var(--dur) var(--ease),
        transform var(--dur) var(--ease);
}

.toast-enter-from,
.toast-leave-to {
    opacity: 0;
    transform: translateY(8px);
}

@media (max-width: 640px) {
    .toasts {
        right: var(--space-3);
        bottom: calc(var(--space-3) + 88px);
        left: var(--space-3);
    }

    .toasts__list {
        align-items: stretch;
    }

    .toast {
        max-width: none;
    }
}
</style>
