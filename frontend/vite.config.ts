import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/*
 * 前端构建产物在 frontend/dist；部署时用根目录的 `pnpm sync:web` 同步到插件数据目录。
 * base 用相对路径：同一份产物可直连插件端口，也能在网关 /web/ 前缀下工作（访问地址需带尾斜杠）。
 */
export default defineConfig({
  plugins: [vue()],
  base: './',
  server: {
    port: 5178,
    proxy: {
      // 插件健康检查与未来的接口：直连插件端口，复用网关会话 cookie（用 127.0.0.1 访问以共享 cookie）
      '/__web': 'http://127.0.0.1:8787',
      '/api': 'http://127.0.0.1:8787',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
})
