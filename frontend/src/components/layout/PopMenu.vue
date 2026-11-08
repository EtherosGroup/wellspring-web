<script setup lang="ts">
/*
 * 弹出菜单容器
 *
 * 负责：锚点定位、点击外部关闭、Esc 关闭、方向键/Home/End 在菜单项间移动。
 * 菜单项自身使用 role="menuitem" 或 button；点击任意项后自动关闭。
 */
import { nextTick, onBeforeUnmount, ref, watch } from "vue"

const props = withDefaults(
    defineProps<{
        open: boolean
        align?: "start" | "end"
        placement?: "down" | "up"
        label?: string
        width?: number
    }>(),
    { align: "start", placement: "down", label: "菜单", width: 0 },
)

const emit = defineEmits<{ (event: "close"): void }>()

const root = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
let previousFocus: HTMLElement | null = null

function menuItems(): HTMLElement[] {
    if (panel.value === null) {
        return []
    }
    return Array.from(
        panel.value.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled]), button:not([disabled])'),
    )
}

function focusItem(index: number): void {
    const items = menuItems()
    if (items.length === 0) {
        return
    }
    const item = items[(index + items.length) % items.length]
    item?.focus()
}

function onPointerDown(event: PointerEvent): void {
    if (!props.open) {
        return
    }
    const target = event.target
    if (root.value !== null && target instanceof Node && !root.value.contains(target)) {
        emit("close")
    }
}

function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
        event.stopPropagation()
        emit("close")
        return
    }
    if (event.key === "ArrowDown") {
        event.preventDefault()
        const current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        const index = current === null ? -1 : menuItems().indexOf(current)
        focusItem(index + 1)
        return
    }
    if (event.key === "ArrowUp") {
        event.preventDefault()
        const current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        const index = current === null ? -1 : menuItems().indexOf(current)
        focusItem(index - 1)
        return
    }
    if (event.key === "Home") {
        event.preventDefault()
        focusItem(0)
        return
    }
    if (event.key === "End") {
        event.preventDefault()
        focusItem(menuItems().length - 1)
        return
    }
    if (event.key === "Tab") {
        emit("close")
    }
}

watch(
    () => props.open,
    (open) => {
        if (open) {
            previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
            document.addEventListener("pointerdown", onPointerDown)
            void nextTick(() => focusItem(0))
        } else {
            document.removeEventListener("pointerdown", onPointerDown)
            const target = previousFocus
            previousFocus = null
            if (target !== null && target.isConnected) {
                target.focus()
            }
        }
    },
)

onBeforeUnmount(() => {
    document.removeEventListener("pointerdown", onPointerDown)
})

function close(): void {
    emit("close")
}
</script>

<template>
    <div ref="root" class="popmenu" @keydown.esc="open && close()">
        <slot />
        <div
            v-if="open"
            ref="panel"
            class="menu popmenu__panel"
            :class="[`popmenu__panel--${align}`, `popmenu__panel--${placement}`]"
            :style="width > 0 ? { width: `${width}px` } : undefined"
            role="menu"
            :aria-label="label"
            @keydown="onKeydown"
            @click="close"
        >
            <slot name="menu" />
        </div>
    </div>
</template>

<style scoped>
.popmenu {
    position: relative;
    display: inline-flex;
    min-width: 0;
}

.popmenu__panel {
    top: calc(100% + 6px);
    bottom: auto;
    max-height: min(60vh, 420px);
    overflow-y: auto;
}

.popmenu__panel--start {
    left: 0;
}

.popmenu__panel--end {
    right: 0;
}

.popmenu__panel--up {
    top: auto;
    bottom: calc(100% + 6px);
    animation-name: menu-up;
}

@keyframes menu-up {
    from {
        opacity: 0;
        transform: translateY(4px) scale(0.98);
    }
    to {
        opacity: 1;
        transform: none;
    }
}
</style>
