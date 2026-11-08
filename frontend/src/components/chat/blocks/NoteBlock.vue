<script setup lang="ts">
/* 提示行：沙盒准备、缓冲截断等 */

import { computed } from "vue"

import Icon from "../../Icon.vue"
import type { NoteBlock } from "../../../types"

const props = defineProps<{ block: NoteBlock }>()

const warn = computed(() => props.block.tone === "warn")
</script>

<template>
    <div class="note" :class="{ 'note--warn': warn }">
        <Icon class="note__icon" :name="warn ? 'alert' : 'info'" :size="14" />
        <span class="note__text">{{ block.text }}</span>
    </div>
</template>

<style scoped>
.note {
    display: flex;
    align-items: flex-start;
    gap: 7px;
    margin: 10px 0;
    color: var(--faint);
    font-size: var(--text-sm);
    line-height: 1.55;
}

.note__icon {
    margin-top: 2px;
}

.note__text {
    min-width: 0;
}

.note--warn {
    color: var(--warn);
}
</style>
