// Discovers VS Code-family Copilot chat telemetry and converts it into the
// same compact parsed-session shape used by Copilot CLI event files.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

import { BILLING } from "../config.mjs";
import { optNum } from "../math.mjs";
import { SURFACE_VSCODE } from "./session-ledger.mjs";

const VSCODE_VARIANTS = ["Code", "Code - Insiders", "Code - Exploration", "VSCodium", "Cursor"];
const COPILOT_EXTENSION_DIRS = ["GitHub.copilot-chat", "github.copilot-chat", "GitHub.copilot", "github.copilot"];
const CHAT_DIRECTORIES = ["chatSessions", "transcripts"];
const DEBUG_DIRECTORIES = ["debug-logs"];
const SKIP_FILE_PARTS = [
    "api.json",
    "cache",
    "config",
    "embeddings",
    "globalsessions",
    "index",
    "models.json",
    "preferences",
    "settings",
    "workspacesessions",
];
const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_EXTENSIONS = new Set([".json", ".jsonl"]);

export function defaultVsCodeUserRoots({
    home = homedir(),
    platform = process.platform,
    env = process.env,
} = {}) {
    const roots = [];
    if (platform === "darwin") {
        roots.push(...VSCODE_VARIANTS.map((name) => join(home, "Library", "Application Support", name, "User")));
    } else if (platform === "win32") {
        const base = env.APPDATA;
        if (base) {
            roots.push(...VSCODE_VARIANTS.map((name) => join(base, name, "User")));
        }
    } else {
        const base = env.XDG_CONFIG_HOME || join(home, ".config");
        roots.push(...VSCODE_VARIANTS.map((name) => join(base, name, "User")));
    }

    roots.push(
        join(home, ".vscode-server", "data", "User"),
        join(home, ".vscode-server-insiders", "data", "User"),
        join(home, ".vscode-remote", "data", "User"),
        "/tmp/.vscode-server/data/User",
        "/workspace/.vscode-server/data/User",
    );

    return unique(roots.map((root) => resolve(root)));
}

export async function discoverVsCodeTelemetryFiles({
    userRoots = defaultVsCodeUserRoots(),
} = {}) {
    const files = [];
    for (const root of unique(userRoots.map((item) => resolve(item)))) {
        files.push(...await discoverRootFiles(root));
    }
    return uniqueFiles(files).sort((left, right) => right.mtimeMs - left.mtimeMs);
}

export async function discoverVsCodeTelemetryGroups(options = {}) {
    return groupVsCodeTelemetryFiles(await discoverVsCodeTelemetryFiles(options));
}

export function groupVsCodeTelemetryFiles(files) {
    const byId = new Map();
    for (const file of files) {
        const id = ledgerId(file, sessionIdFromPath(file.path) ?? basename(file.path, extname(file.path)));
        const group = byId.get(id) ?? { id, files: [], eventFileMtimeMs: undefined, eventFileSize: undefined };
        group.files.push(file);
        mergeFileMeta(group, file);
        byId.set(id, group);
    }
    return Array.from(byId.values()).sort((left, right) => (right.eventFileMtimeMs ?? 0) - (left.eventFileMtimeMs ?? 0));
}

export async function parseVsCodeTelemetryGroups(groupsOrFiles) {
    const groups = groupsOrFiles.some((item) => Array.isArray(item.files))
        ? groupsOrFiles
        : groupVsCodeTelemetryFiles(groupsOrFiles);
    const parsed = [];
    for (const group of groups) {
        parsed.push(...await parseVsCodeTelemetryGroup(group));
    }
    return parsed;
}

export async function parseVsCodeTelemetryGroup(group) {
    const byId = new Map();
    for (const file of group.files ?? []) {
        const records = await parseVsCodeTelemetryFile(file);
        for (const record of records) {
            if (!record.id) {
                continue;
            }
            const group = byId.get(record.id) ?? newGroup(record.id);
            mergeRecord(group, record);
            mergeFileMeta(group, file);
            byId.set(record.id, group);
        }
    }
    return Array.from(byId.values()).map(groupSummary);
}

export async function parseVsCodeTelemetryFile(file) {
    if (!JSON_EXTENSIONS.has(extname(file.path).toLowerCase()) || shouldSkipFile(file.path)) {
        return [];
    }

    const state = await readTelemetryState(file.path);
    if (!state) {
        return [];
    }

    if (isDebugState(state)) {
        return debugRecords(state.events, file);
    }
    return requestRecords(requestsFromState(state.value), file, state.value);
}

async function discoverRootFiles(root) {
    const files = [];
    const workspaceRoot = join(root, "workspaceStorage");
    for (const workspace of await childDirectories(workspaceRoot)) {
        files.push(...await jsonFiles(join(workspace.path, "chatSessions"), {
            root,
            workspaceKey: workspace.name,
            kind: "chat",
        }));
        for (const extensionName of COPILOT_EXTENSION_DIRS) {
            const extensionRoot = join(workspace.path, extensionName);
            for (const directory of CHAT_DIRECTORIES) {
                files.push(...await jsonFiles(join(extensionRoot, directory), {
                    root,
                    workspaceKey: workspace.name,
                    kind: "chat",
                }));
            }
            for (const directory of DEBUG_DIRECTORIES) {
                files.push(...await jsonFiles(join(extensionRoot, directory), {
                    root,
                    workspaceKey: workspace.name,
                    kind: "debug",
                    recursive: true,
                }));
            }
        }
    }

    files.push(...await jsonFiles(join(root, "globalStorage", "emptyWindowChatSessions"), {
        root,
        workspaceKey: "global",
        kind: "chat",
    }));
    for (const extensionName of COPILOT_EXTENSION_DIRS) {
        files.push(...await jsonFiles(join(root, "globalStorage", extensionName), {
            root,
            workspaceKey: "global",
            kind: "global",
            recursive: true,
        }));
    }
    return files;
}

async function childDirectories(root) {
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
        if (error?.code === "ENOENT") {
            return [];
        }
        throw error;
    }
    return entries.filter((entry) => entry.isDirectory()).map((entry) => ({
        name: entry.name,
        path: join(root, entry.name),
    }));
}

async function jsonFiles(root, meta) {
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
        if (error?.code === "ENOENT") {
            return [];
        }
        throw error;
    }

    const files = [];
    for (const entry of entries) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
            if (meta.recursive) {
                files.push(...await jsonFiles(path, meta));
            }
            continue;
        }
        if (!entry.isFile() || !JSON_EXTENSIONS.has(extname(entry.name).toLowerCase()) || shouldSkipFile(entry.name)) {
            continue;
        }
        const details = await stat(path);
        files.push({ ...meta, path, mtimeMs: details.mtimeMs, size: details.size });
    }
    return files;
}

async function readTelemetryState(filePath) {
    const lines = [];
    const input = createInterface({
        input: createReadStream(filePath, { encoding: "utf8" }),
        crlfDelay: Infinity,
    });
    for await (const line of input) {
        if (line.trim()) {
            lines.push(line);
        }
    }
    if (!lines.length || (lines.length === 1 && UUID_ONLY.test(lines[0].trim()))) {
        return undefined;
    }

    if (lines.length === 1 && extname(filePath).toLowerCase() === ".json") {
        try {
            return { value: JSON.parse(lines[0]), events: [] };
        } catch {
            return undefined;
        }
    }

    const events = [];
    for (const line of lines) {
        try {
            events.push(JSON.parse(line));
        } catch {
            // Partial VS Code JSONL writes are expected; keep usable rows.
        }
    }
    if (!events.length) {
        return undefined;
    }
    if (events.some((event) => typeof event?.kind === "number")) {
        return { value: applyDeltaEvents(events), events };
    }
    return { value: { events }, events };
}

function applyDeltaEvents(events) {
    let state = {};
    for (const event of events) {
        if (event.kind === 0 && event.v && typeof event.v === "object") {
            state = event.v;
            continue;
        }
        if (event.kind === 1 && Array.isArray(event.k)) {
            setPath(state, event.k, event.v);
            continue;
        }
        if (event.kind === 2 && Array.isArray(event.k)) {
            const current = getPath(state, event.k);
            setPath(state, event.k, [...(Array.isArray(current) ? current : []), ...(Array.isArray(event.v) ? event.v : [event.v])]);
        }
    }
    return state;
}

function requestsFromState(value = {}) {
    if (Array.isArray(value?.requests)) {
        return value.requests;
    }
    if (Array.isArray(value?.v?.requests)) {
        return value.v.requests;
    }
    if (Array.isArray(value?.events)) {
        return [];
    }
    return [];
}

function requestRecords(requests, file, state) {
    return requests.map((request) => requestRecord(request, file, state)).filter(Boolean);
}

function requestRecord(request = {}, file, state = {}) {
    const sessionId = stringValue(request.result?.metadata?.sessionId)
        ?? stringValue(request.sessionId)
        ?? sessionIdFromPath(file.path)
        ?? basename(file.path, extname(file.path));
    const at = optNum(request.modelState?.completedAt)
        ?? optNum(request.result?.metadata?.completedAt)
        ?? optNum(request.timestamp)
        ?? optNum(request.result?.metadata?.timestamp);
    const model = modelName(request, state);
    const totalNanoAiu = nanoAiuFromRequest(request);
    const tokens = tokenTotalsFromRequest(request);
    return cleanRecord({
        id: ledgerId(file, sessionId),
        requestKey: stringValue(request.responseId) ?? stringValue(request.requestId) ?? `${sessionId}:${at ?? ""}`,
        at,
        totalNanoAiu,
        model,
        tokenTotals: addTokenTotals(tokens, { requestCount: 1 }),
    });
}

function debugRecords(events, file) {
    return events
        .filter((event) => isLlmRequestEvent(event))
        .map((event) => {
            const attrs = event.attrs ?? {};
            const sessionId = stringValue(event.sid) ?? sessionIdFromPath(file.path) ?? basename(dirname(file.path));
            const model = stringValue(attrs.model)
                ?? stringValue(attrs.resolvedModel)
                ?? stringValue(attrs["gen_ai.request.model"]);
            const tokens = tokenTotalsFromDebugAttrs(attrs);
            return cleanRecord({
                id: ledgerId(file, sessionId),
                requestKey: stringValue(attrs.requestId) ?? stringValue(attrs.responseId) ?? stringValue(event.spanId) ?? `${sessionId}:${event.ts ?? ""}`,
                at: optNum(event.ts),
                totalNanoAiu: optNum(attrs.copilotUsageNanoAiu)
                    ?? optNum(attrs.totalNanoAiu)
                    ?? creditsToNanoAiu(optNum(attrs.credits) ?? optNum(attrs.copilotUsageCredits)),
                model,
                tokenTotals: addTokenTotals(tokens, { requestCount: 1 }),
            });
        })
        .filter(Boolean);
}

function isDebugState(state) {
    return state.events?.some((event) => isLlmRequestEvent(event));
}

function isLlmRequestEvent(event) {
    const type = String(event?.type ?? event?.name ?? "");
    return type === "llm_request" || type.endsWith(".llm_request") || type.includes("llm.request");
}

function mergeRecord(group, record) {
    const existing = group.requests.get(record.requestKey) ?? {};
    const preferred = preferredRecord(existing, record);
    const merged = {
        ...existing,
        ...record,
        totalNanoAiu: optNum(preferred.totalNanoAiu) ?? optNum(record.totalNanoAiu) ?? optNum(existing.totalNanoAiu),
        tokenTotals: preferred.tokenTotals,
        model: preferred.model ?? record.model ?? existing.model,
        at: optNum(record.at) ?? optNum(existing.at),
    };
    group.requests.set(record.requestKey, merged);
}

function mergeFileMeta(group, file) {
    group.eventFileMtimeMs = Math.max(group.eventFileMtimeMs ?? 0, file.mtimeMs ?? 0);
    group.eventFileSize = (group.eventFileSize ?? 0) + (file.size ?? 0);
}

function groupSummary(group) {
    const summary = {
        id: group.id,
        surface: SURFACE_VSCODE,
        firstSeenAt: undefined,
        lastSeenAt: undefined,
        usageNanoAiu: undefined,
        tokenTotals: undefined,
        modelMetrics: {},
        eventFileMtimeMs: group.eventFileMtimeMs,
        eventFileSize: group.eventFileSize,
    };

    for (const record of group.requests.values()) {
        summary.firstSeenAt = minDefined(summary.firstSeenAt, record.at);
        summary.lastSeenAt = maxDefined(summary.lastSeenAt, record.at);
        const nano = optNum(record.totalNanoAiu);
        if (nano !== undefined) {
            summary.usageNanoAiu = num(summary.usageNanoAiu) + nano;
        }
        summary.tokenTotals = addTokenTotals(summary.tokenTotals, record.tokenTotals);
        if (record.model) {
            mergeModelMetric(summary, record.model, {
                totalNanoAiu: nano,
                tokenTotals: record.tokenTotals,
            });
        }
    }
    return dropEmpty(summary);
}

function nanoAiuFromRequest(request) {
    return optNum(request.result?.usage?.copilotUsage?.totalNanoAiu)
        ?? optNum(request.result?.usage?.copilot_usage?.total_nano_aiu)
        ?? optNum(request.result?.metadata?.copilotUsage?.totalNanoAiu)
        ?? optNum(request.result?.metadata?.copilot_usage?.total_nano_aiu)
        ?? creditsFromDetails(request.result?.details)
        ?? creditsFromDetails(request.result?.metadata?.details);
}

function creditsFromDetails(value) {
    const match = /(?:^|[^\d.])(\d+(?:\.\d+)?)\s+credits?\b/i.exec(String(value ?? ""));
    return match ? creditsToNanoAiu(Number(match[1])) : undefined;
}

function creditsToNanoAiu(credits) {
    return optNum(credits) === undefined ? undefined : Math.round(credits * BILLING.nanoAiuPerAiCredit);
}

function tokenTotalsFromRequest(request) {
    return cleanTokens({
        inputTokens: optNum(request.result?.usage?.inputTokens)
            ?? optNum(request.result?.usage?.prompt_tokens)
            ?? optNum(request.result?.metadata?.promptTokens)
            ?? optNum(request.promptTokens),
        cacheReadTokens: optNum(request.result?.usage?.cacheReadTokens)
            ?? optNum(request.result?.usage?.cached_tokens)
            ?? optNum(request.result?.metadata?.cacheReadTokens),
        cacheWriteTokens: optNum(request.result?.usage?.cacheWriteTokens)
            ?? optNum(request.result?.metadata?.cacheWriteTokens),
        outputTokens: optNum(request.result?.usage?.outputTokens)
            ?? optNum(request.result?.usage?.completion_tokens)
            ?? optNum(request.result?.metadata?.outputTokens)
            ?? optNum(request.result?.metadata?.completionTokens)
            ?? optNum(request.completionTokens),
        reasoningTokens: optNum(request.result?.usage?.reasoningTokens)
            ?? optNum(request.result?.usage?.reasoning_tokens)
            ?? optNum(request.result?.metadata?.reasoningTokens),
    });
}

function tokenTotalsFromDebugAttrs(attrs = {}) {
    return cleanTokens({
        inputTokens: optNum(attrs.inputTokens) ?? optNum(attrs.promptTokens) ?? optNum(attrs.prompt_tokens),
        cacheReadTokens: optNum(attrs.cachedTokens) ?? optNum(attrs.cacheReadTokens) ?? optNum(attrs.cache_read_tokens),
        cacheWriteTokens: optNum(attrs.cacheWriteTokens) ?? optNum(attrs.cache_write_tokens),
        outputTokens: optNum(attrs.outputTokens) ?? optNum(attrs.completionTokens) ?? optNum(attrs.completion_tokens),
        reasoningTokens: optNum(attrs.reasoningTokens) ?? optNum(attrs.reasoning_tokens),
    });
}

function modelName(request = {}, state = {}) {
    return normalizeVsCodeModelName(stringValue(request.result?.metadata?.resolvedModel)
        ?? stringValue(request.result?.metadata?.model)
        ?? stringValue(request.model)
        ?? selectedModelName(request)
        ?? selectedModelName(state)
        ?? stringValue(request.modelId));
}

function selectedModelName(request = {}) {
    const metadata = request.inputState?.selectedModel?.metadata
        ?? request.selectedModel?.metadata
        ?? request.result?.metadata?.selectedModel?.metadata;
    return stringValue(metadata?.name)
        ?? stringValue(metadata?.family)
        ?? stringValue(metadata?.version)
        ?? stringValue(metadata?.id);
}

function normalizeVsCodeModelName(value) {
    const model = stringValue(value)?.replace(/^copilot\//i, "");
    return model?.replace(/(\d)-(\d)/g, "$1.$2");
}

function ledgerId(file, sessionId) {
    return `vscode:${hash(resolve(file.root ?? dirname(file.path))).slice(0, 8)}:${sanitize(file.workspaceKey ?? workspaceKeyFromPath(file.path))}:${sanitize(sessionId)}`;
}

function sessionIdFromPath(path) {
    const parts = path.split(sep);
    const debugIndex = parts.lastIndexOf("debug-logs");
    if (debugIndex >= 0 && parts[debugIndex + 1]) {
        return parts[debugIndex + 1];
    }
    return basename(path, extname(path));
}

function workspaceKeyFromPath(path) {
    const parts = path.split(sep);
    const index = parts.lastIndexOf("workspaceStorage");
    return index >= 0 && parts[index + 1] ? parts[index + 1] : "global";
}

function shouldSkipFile(path) {
    const normalized = relative("/", resolve(path)).toLowerCase();
    return SKIP_FILE_PARTS.some((part) => normalized.includes(part));
}

function newGroup(id) {
    return { id, requests: new Map(), eventFileMtimeMs: undefined, eventFileSize: undefined };
}

function setPath(target, path, value) {
    const parent = path.slice(0, -1).reduce((object, key) => {
        object[key] ??= typeof key === "number" ? [] : {};
        return object[key];
    }, target);
    parent[path.at(-1)] = value;
}

function getPath(target, path) {
    return path.reduce((object, key) => object?.[key], target);
}

function mergeModelMetric(summary, model, patch) {
    const prior = summary.modelMetrics[model] ?? {};
    summary.modelMetrics[model] = {
        totalNanoAiu: num(prior.totalNanoAiu) + num(patch.totalNanoAiu) || undefined,
        tokenTotals: addTokenTotals(prior.tokenTotals, patch.tokenTotals),
    };
}

function addTokenTotals(left, right) {
    const keys = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "requestCount", "requestCostUnits"];
    const totals = {};
    for (const key of keys) {
        const value = num(left?.[key]) + num(right?.[key]);
        if (value > 0) {
            totals[key] = value;
        }
    }
    return Object.keys(totals).length ? totals : undefined;
}

function cleanTokens(value) {
    const tokens = Object.fromEntries(Object.entries(value).filter(([, item]) => optNum(item) !== undefined && item > 0));
    return Object.keys(tokens).length ? tokens : undefined;
}

function preferredRecord(left, right) {
    if (tokenDetailScore(right?.tokenTotals) >= tokenDetailScore(left?.tokenTotals)) {
        return right;
    }
    return left;
}

function tokenDetailScore(tokens = {}) {
    const detailKeys = ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens"];
    return detailKeys.filter((key) => optNum(tokens[key]) > 0).length * 1_000
        + ["inputTokens", "outputTokens"].filter((key) => optNum(tokens[key]) > 0).length * 100
        + num(tokens.requestCount);
}

function cleanRecord(record) {
    return record?.id && record?.requestKey ? dropEmpty(record) : undefined;
}

function minDefined(left, right) {
    if (left === undefined) {
        return right;
    }
    if (right === undefined) {
        return left;
    }
    return Math.min(left, right);
}

function maxDefined(left, right) {
    if (left === undefined) {
        return right;
    }
    if (right === undefined) {
        return left;
    }
    return Math.max(left, right);
}

function stringValue(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sanitize(value) {
    return String(value ?? "unknown").replace(/[^A-Za-z0-9._:-]/g, "-");
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

function uniqueFiles(files) {
    const byPath = new Map();
    for (const file of files) {
        const key = resolve(file.path).toLowerCase();
        if (!byPath.has(key)) {
            byPath.set(key, file);
        }
    }
    return [...byPath.values()];
}

function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}

function num(value) {
    return optNum(value) ?? 0;
}

function dropEmpty(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => {
        if (item === undefined) {
            return false;
        }
        if (item && typeof item === "object" && !Array.isArray(item)) {
            return Object.keys(item).length > 0;
        }
        return true;
    }));
}
