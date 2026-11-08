import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"

/*
 * 构建产物直接写进插件根目录的 www/，由插件 HTTP 服务下发
 * base 用相对路径：直连端口与网关前缀（/web）两种入口都能加载资源
 */
export default defineConfig({
    plugins: [vue()],
    base: "./",
    server: {
        port: 5178,
        proxy: {
            "/api": "http://127.0.0.1:8787",
            "/__web": "http://127.0.0.1:8787",
        },
    },
    build: {
        outDir: "../www",
        emptyOutDir: true,
        target: "es2022",
        assetsInlineLimit: 2048,
        cssCodeSplit: false,
        chunkSizeWarningLimit: 900,
        rollupOptions: {
            output: {
                entryFileNames: "assets/app-[hash].js",
                chunkFileNames: "assets/chunk-[hash].js",
                assetFileNames: "assets/[name]-[hash][extname]",
            },
        },
    },
})
