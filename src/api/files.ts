/*
 * 工作区与文件接口
 *
 * GET/POST /api/workspaces、DELETE /api/workspaces/:id、POST /api/workspaces/validate、
 * GET /api/files、POST /api/files/open
 */

import type {
    HostWorkspaceCheck,
    HostWorkspaceEntry,
    HttpRequest,
    HttpResponse,
} from "wellspring/api/host/index.ts"

import { errorResponse, jsonResponse, readJsonObject } from "../security.ts"
import {
    decodeSegment,
    hostCapabilityError,
    hostErrorText,
    isPlainObject,
    type ApiContext,
} from "./context.ts"

const MAX_WORKSPACE_NAME = 60

function isAbsolutePath(value: string): boolean {
    return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")
}

function absolutePathOf(value: unknown): string | null {
    if (typeof value !== "string") {
        return null
    }
    const path = value.trim()
    return path !== "" && isAbsolutePath(path) ? path : null
}

function nameOf(value: unknown): string | null | undefined {
    if (value === undefined) {
        return undefined
    }
    if (typeof value !== "string") {
        return null
    }
    const trimmed = value.trim()
    return trimmed === "" ? undefined : trimmed.slice(0, MAX_WORKSPACE_NAME)
}

async function listWorkspaces(ctx: ApiContext): Promise<readonly HostWorkspaceEntry[]> {
    return (await ctx.api.workspaces.list()).workspaces
}

/** GET /api/workspaces */
export async function handleListWorkspaces(ctx: ApiContext): Promise<HttpResponse> {
    try {
        return jsonResponse(200, { workspaces: await listWorkspaces(ctx) })
    } catch (error) {
        return hostCapabilityError(error)
    }
}

/** POST /api/workspaces：{ root, name? } 或 { pick: true } */
export async function handleAddWorkspace(
    ctx: ApiContext,
    request: HttpRequest,
): Promise<HttpResponse> {
    const body = readJsonObject(request, ctx.config.limits.maxBodyBytes)
    if (body.response !== undefined || !isPlainObject(body.value)) {
        return body.response ?? errorResponse(400, "请求体不是 JSON 对象", "invalid-json")
    }
    const name = nameOf(body.value["name"])
    if (name === null) {
        return errorResponse(400, "工作区名称不合法", "invalid-name")
    }
    let root: string
    if (body.value["pick"] === true) {
        let check: HostWorkspaceCheck
        try {
            check = await ctx.api.agent.pickDirectory()
        } catch (error) {
            return hostCapabilityError(error)
        }
        if (!check.ok) {
            return errorResponse(400, check.error ?? "未选择目录", "pick-cancelled")
        }
        root = check.root
    } else {
        const requested = absolutePathOf(body.value["root"])
        if (requested === null) {
            return errorResponse(400, "工作区路径不是绝对路径", "invalid-root")
        }
        let check: HostWorkspaceCheck
        try {
            check = await ctx.api.agent.validateWorkspace(requested)
        } catch (error) {
            return hostCapabilityError(error)
        }
        if (!check.ok) {
            return errorResponse(400, check.error ?? "工作区不可用", "invalid-root")
        }
        root = check.root
    }
    try {
        const result = await ctx.api.workspaces.add({
            root,
            ...(name === undefined ? {} : { name }),
        })
        return jsonResponse(200, {
            workspace: result.workspace,
            workspaces: await listWorkspaces(ctx),
        })
    } catch (error) {
        return hostCapabilityError(error)
    }
}

/** DELETE /api/workspaces/:id */
export async function handleRemoveWorkspace(
    ctx: ApiContext,
    rawId: string,
): Promise<HttpResponse> {
    const id = decodeSegment(rawId)
    if (id === null) {
        return errorResponse(400, "工作区 id 不合法", "invalid-id")
    }
    try {
        const result = await ctx.api.workspaces.remove(id)
        return jsonResponse(200, { ok: result.removed, workspaces: await listWorkspaces(ctx) })
    } catch (error) {
        return hostCapabilityError(error)
    }
}

/** POST /api/workspaces/validate */
export async function handleValidateWorkspace(
    ctx: ApiContext,
    request: HttpRequest,
): Promise<HttpResponse> {
    const body = readJsonObject(request, ctx.config.limits.maxBodyBytes)
    if (body.response !== undefined || !isPlainObject(body.value)) {
        return body.response ?? errorResponse(400, "请求体不是 JSON 对象", "invalid-json")
    }
    const root = absolutePathOf(body.value["root"])
    if (root === null) {
        return errorResponse(400, "工作区路径不是绝对路径", "invalid-root")
    }
    try {
        return jsonResponse(200, await ctx.api.agent.validateWorkspace(root))
    } catch (error) {
        return hostCapabilityError(error)
    }
}

/** GET /api/files?root=<abs>&q=<query> */
export async function handleFiles(ctx: ApiContext, url: URL): Promise<HttpResponse> {
    const root = absolutePathOf(url.searchParams.get("root"))
    if (root === null) {
        return errorResponse(400, "工作区路径不是绝对路径", "invalid-root")
    }
    const query = url.searchParams.get("q") ?? ""
    try {
        return jsonResponse(200, await ctx.api.agent.searchWorkspaceFiles(root, query))
    } catch (error) {
        const capability = hostCapabilityError(error)
        return capability.status === 501
            ? capability
            : errorResponse(400, hostErrorText(error), "file-search-failed")
    }
}

/** POST /api/files/open */
export async function handleOpenFile(ctx: ApiContext, request: HttpRequest): Promise<HttpResponse> {
    const body = readJsonObject(request, ctx.config.limits.maxBodyBytes)
    if (body.response !== undefined || !isPlainObject(body.value)) {
        return body.response ?? errorResponse(400, "请求体不是 JSON 对象", "invalid-json")
    }
    const path = absolutePathOf(body.value["path"])
    if (path === null) {
        return errorResponse(400, "文件路径不是绝对路径", "invalid-path")
    }
    const rawMode = body.value["mode"]
    if (rawMode !== undefined && rawMode !== "default" && rawMode !== "reveal") {
        return errorResponse(400, "打开方式不合法", "invalid-mode")
    }
    try {
        await ctx.api.agent.openPath(path, rawMode === "reveal" ? "reveal" : "default")
        return jsonResponse(200, { ok: true })
    } catch (error) {
        return hostCapabilityError(error)
    }
}
