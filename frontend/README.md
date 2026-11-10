# wellspring-web-frontend

Wellspring Web 插件的起始前端：Vue 3 + TypeScript + Vite，样式用 SCSS。

- 开发：根目录 `pnpm dev:ui`（http://127.0.0.1:5178/，`/__web` 与 `/api` 代理到插件端口 8787）
- 构建：根目录 `pnpm build:ui` → `frontend/dist`
- 部署：根目录 `pnpm sync:web`（`--clean` 先清空目标目录）→ 插件数据目录 `www/`
- 加依赖：`pnpm -C frontend add <pkg>`

未安装 Vue DevTools 插件（`vite-plugin-vue-devtools`）。设计令牌在 `src/styles/_tokens.scss`，全局样式在 `src/styles/main.scss`，页面从 `src/App.vue` 开始写。
