<script setup lang="ts">
const title = 'Wellspring Web'
</script>

<template>
    <main class="page">
        <h1 class="page__title">{{ title }}</h1>
        <p class="page__text">前端已就绪。从 <code>src/App.vue</code> 开始编写页面。</p>
        <p class="page__text">
            构建产物在 <code>frontend/dist</code>，用根目录的 <code>pnpm sync:web</code> 同步到插件数据目录。
        </p>
    </main>
</template>

<style scoped lang="scss">
@use './styles/tokens' as *;

.page {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 100vh;
    padding: 32px;
    text-align: center;

    &__title {
        margin: 0 0 8px;
        font-size: 26px;
        font-weight: 600;
        color: $color-accent;
    }

    &__text {
        max-width: 560px;
        margin: 0;
        font-size: 14px;
        line-height: 1.8;
        color: $color-muted;
    }
}

@media (prefers-color-scheme: dark) {
    .page {
        &__title {
            color: $color-accent-dark;
        }

        &__text {
            color: $color-muted-dark;
        }
    }
}
</style>
