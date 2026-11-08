<script setup lang="ts">
/* 插话回显：一行，标出来自用户 */

import Icon from "../../Icon.vue"
import type { SteerBlock } from "../../../types"

defineProps<{ block: SteerBlock }>()
</script>

<template>
    <div class="steer">
        <Icon class="steer__icon" name="enter" :size="14" />
        <span class="steer__label">插话</span>
        <span class="steer__text">{{ block.text }}</span>
    </div>
</template>

<style scoped>
.steer {
    display: flex;
    align-items: baseline;
    gap: 7px;
    margin: 10px 0;
    padding: 7px 11px;
    border-left: 2px solid color-mix(in srgb, var(--accent) 45%, transparent);
    border-radius: 0 var(--radius-xs) var(--radius-xs) 0;
    background: var(--accent-softer);
    color: var(--ink-2);
    font-size: var(--text-sm);
    line-height: 1.55;
}

.steer__icon {
    align-self: center;
    color: var(--accent);
}

.steer__label {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: 0.04em;
    color: var(--accent);
    text-transform: uppercase;
}

.steer__text {
    min-width: 0;
    overflow-wrap: anywhere;
}
</style>
