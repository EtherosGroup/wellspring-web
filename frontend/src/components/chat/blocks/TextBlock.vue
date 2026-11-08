<script setup lang="ts">
/* 正文块：Markdown 正文 + 流式光标 */

import type { TextBlock } from "../../../types"
import MarkdownText from "../MarkdownText.vue"

withDefaults(defineProps<{ block: TextBlock; streaming?: boolean }>(), { streaming: false })
</script>

<template>
    <div class="text-block">
        <MarkdownText :text="block.text" :streaming="streaming" />
        <span v-if="streaming" class="text-block__caret" aria-hidden="true" />
    </div>
</template>

<style scoped>
.text-block {
    position: relative;
}

.text-block__caret {
    display: inline-block;
    width: 2px;
    height: 1.05em;
    margin-left: 3px;
    vertical-align: text-bottom;
    border-radius: 1px;
    background: var(--accent);
    animation: caret-blink 1.1s steps(1, end) infinite;
}
</style>
