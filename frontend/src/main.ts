import { createApp } from "vue"

import App from "./App.vue"
import "./style.css"

const THEME_KEY = "wellspring.web.theme"

/** 服务端已按 cookie 注入 data-theme；没有有效值时按本地偏好/系统补齐，避免首屏闪错 */
function resolveTheme(): "light" | "dark" {
    const injected = document.documentElement.dataset["theme"]
    if (injected === "light" || injected === "dark") {
        return injected
    }
    let saved: string | null = null
    try {
        saved = localStorage.getItem(THEME_KEY)
    } catch {
        saved = null
    }
    if (saved === "light" || saved === "dark") {
        return saved
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

document.documentElement.dataset["theme"] = resolveTheme()

createApp(App).mount("#app")
