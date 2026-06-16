// Lightweight hot-path state for footer and after-message rendering.
// The historical ledger remains the source of truth for synced sessions; this
// file holds only current display state and cached rolling windows.

import { readJson, updateJson, writeJson } from "./io.mjs";
import { optNum } from "./math.mjs";
import { sessionKey, summaryStatePath } from "./storage.mjs";

export const SUMMARY_STATE_VERSION = 1;

export async function readSummaryState(path = summaryStatePath()) {
    return normalizeSummaryState(await readJson(path));
}

export async function writeSummaryState(state, path = summaryStatePath()) {
    const normalized = normalizeSummaryState(state);
    await writeJson(path, normalized);
    return normalized;
}

export async function updateSummaryState(updater, path = summaryStatePath()) {
    return updateJson(path, async (state) => normalizeSummaryState(await updater(normalizeSummaryState(state))));
}

export async function readRuntimeState(workspacePath, path = summaryStatePath()) {
    if (!workspacePath) {
        return undefined;
    }
    return (await readSummaryState(path)).runtime[sessionKey(workspacePath)];
}

export async function readRuntimeSessions(path = summaryStatePath()) {
    return Object.values((await readSummaryState(path)).runtime)
        .filter((record) => cleanId(record?.sessionId));
}

export async function mergeRuntimeState(workspacePath, patch = {}, path = summaryStatePath()) {
    if (!workspacePath) {
        return applyPatch(undefined, patch);
    }

    let returned;
    await updateSummaryState((state) => {
        const key = sessionKey(workspacePath);
        const prior = state.runtime[key];
        returned = applyPatch(prior, patch);
        state.runtime[key] = applyPatch(prior, persistedRuntimePatch(patch));
        return state;
    }, path);
    return returned;
}

export async function readUsageWindows(now = Date.now(), path = summaryStatePath()) {
    void now;
    return pickWindows((await readSummaryState(path)).windows);
}

export async function claimUsageWindowSync({ now = Date.now(), staleAfterMs = 5 * 60 * 1000, path = summaryStatePath() } = {}) {
    let claimed = false;
    await updateSummaryState((state) => {
        const lastSyncedAt = optNum(state.windows.updatedAt);
        if (lastSyncedAt !== undefined && now - lastSyncedAt < staleAfterMs) {
            return state;
        }
        claimed = true;
        state.windows = normalizeWindows({ ...state.windows, updatedAt: now });
        return state;
    }, path);
    return claimed;
}

export async function saveUsageWindows(windows = {}, { updatedAt = Date.now() } = {}, path = summaryStatePath()) {
    return updateSummaryState((state) => {
        state.windows = normalizeWindows({ ...windows, updatedAt });
        return state;
    }, path);
}

export async function pruneSummarySessions(closedSessionIds = [], path = summaryStatePath()) {
    const closed = new Set([...closedSessionIds].map(cleanId).filter(Boolean));
    if (!closed.size) {
        return readSummaryState(path);
    }

    return updateSummaryState((state) => {
        for (const id of closed) {
            removeRuntimeBySessionId(state, id);
        }
        return state;
    }, path);
}

export function normalizeSummaryState(value = {}) {
    return {
        version: SUMMARY_STATE_VERSION,
        windows: normalizeWindows(value?.windows),
        runtime: normalizeRuntime(value?.runtime),
    };
}

function normalizeWindows(value = {}) {
    return dropUndefined({
        window24hUsd: optNum(value?.window24hUsd),
        window7dUsd: optNum(value?.window7dUsd),
        window30dUsd: optNum(value?.window30dUsd),
        updatedAt: optNum(value?.updatedAt),
    });
}

function pickWindows(value = {}) {
    return dropUndefined({
        window24hUsd: optNum(value.window24hUsd) ?? 0,
        window7dUsd: optNum(value.window7dUsd) ?? 0,
        window30dUsd: optNum(value.window30dUsd) ?? 0,
    });
}

function normalizeRuntime(value = {}) {
    if (!value || typeof value !== "object") {
        return {};
    }
    return Object.fromEntries(Object.entries(value)
        .filter(([key, record]) => cleanId(key) && record && typeof record === "object")
        .map(([key, record]) => [key, dropUndefined(record)]));
}

function applyPatch(state = {}, patch = {}) {
    const next = { ...state };
    for (const [key, value] of Object.entries(patch ?? {})) {
        if (value === undefined) {
            continue;
        }
        if (value === null) {
            delete next[key];
            continue;
        }
        next[key] = value;
    }
    return next;
}

function persistedRuntimePatch(patch = {}) {
    return Object.fromEntries(Object.entries(patch).filter(([key]) => !key.startsWith("window")));
}

function removeRuntimeBySessionId(state, sessionId) {
    for (const [key, record] of Object.entries(state.runtime)) {
        if (record?.sessionId === sessionId) {
            delete state.runtime[key];
        }
    }
}

function cleanId(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function dropUndefined(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
