<script setup lang="ts">
/** 内联 SVG 图标：symbol 定义在 index.html 的 sprite 里 */
withDefaults(
    defineProps<{
        name: string
        size?: number
        strokeWidth?: number
    }>(),
    { size: 18, strokeWidth: 1.7 },
)
</script>

<template>
    <svg
        class="icon"
        :width="size"
        :height="size"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        :stroke-width="strokeWidth"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        focusable="false"
    >
        <use :href="`#i-${name}`" />
    </svg>
</template>

<style scoped>
.icon {
    display: block;
    flex: none;
}
</style>
