// Discovers local Copilot session telemetry and folds it into the session ledger.

import { open, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
    autoCloseStaleSessions,
    closeFromShutdown,
    mergeSession,
    pruneLedger,
    readSessionLedger,
    SOURCE_COMPACTION,
    SOURCE_NONE,
    SOURCE_RUNTIME,
    SOURCE_USAGE_EVENTS,
    SOURCE_MODEL_METRICS,
    SOURCE_SHUTDOWN,
    STATE_OPEN,
    STATE_AUTO_CLOSED,
    STATE_CLOSED,
    SURFACE_CLI,
} from "./session-ledger.mjs";
import { parseSessionEvents } from "./session-jsonl.mjs";
import { discoverVsCodeTelemetryGroups, parseVsCodeTelemetryGroup } from "./vscode-session.mjs";
import { syncSessionLedgerCacheAndSummary } from "./windows.mjs";
import { HISTORY } from "../config.mjs";
import { optNum } from "../math.mjs";
import { timestampMs } from "../render/format.mjs";
import { sessionLedgerPath, sessionStateRootPath } from "../storage.mjs";
import { readRuntimeSessions } from "../summary-state.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = HISTORY.retentionDays * DAY_MS;
const LAST_EVENT_TAIL_BYTES = 256 * 1024;
const NANO_AIU_PER_USD = 100_000_000_000;

export async function syncSessionLedger({
    currentSessionId,
    sessionStateRoot = sessionStateRootPath(),
    includeVsCodeTelemetry,
    includeRuntimeState,
    vsCodeUserRoots,
    ledgerPath = sessionLedgerPath(),
    summaryPath,
    now = Date.now(),
} = {}) {
    const defaultLedgerPath = sessionLedgerPath();
    const effectiveSummaryPath = summaryPath ?? (ledgerPath === defaultLedgerPath ? undefined : join(dirname(ledgerPath), "summary-state.json"));
    const shouldIncludeVsCode = includeVsCodeTelemetry ?? (vsCodeUserRoots !== undefined || ledgerPath === defaultLedgerPath);
    const shouldIncludeRuntime = includeRuntimeState ?? (summaryPath !== undefined || ledgerPath === defaultLedgerPath);
    const snapshot = await readSessionLedger(ledgerPath);
    const parsedSessions = [];
    for (const file of await discoverSessionEventFiles(sessionStateRoot)) {
        const prior = snapshot.sessions[file.id];
        if (prior && file.id !== currentSessionId && shouldSkipTrustedSession(prior, file, now)) {
            continue;
        }
        const latestEventAt = await latestSessionEventAt(file.path) ?? file.mtimeMs;
        if (!shouldParseSessionFile(prior, { ...file, latestEventAt }, { currentSessionId, now })) {
            continue;
        }
        parsedSessions.push(await parseSessionEvents(file.path, { id: file.id }));
    }
    if (shouldIncludeVsCode) {
        for (const group of await discoverVsCodeTelemetryGroups({ userRoots: vsCodeUserRoots })) {
            const prior = snapshot.sessions[group.id];
            if (shouldParseVsCodeSession(prior, group, now)) {
                parsedSessions.push(...await parseVsCodeTelemetryGroup(group));
            }
        }
    }
    const runtimeSessions = shouldIncludeRuntime ? await runtimeLedgerSessions(effectiveSummaryPath) : [];

    return syncSessionLedgerCacheAndSummary((existing) => syncSessionLedgerValue(existing, {
        currentSessionId,
        parsedSessions,
        runtimeSessions,
        now,
    }), ledgerPath, now, effectiveSummaryPath);
}

function syncSessionLedgerValue(existing, { currentSessionId, parsedSessions, runtimeSessions, now }) {
    let ledger = existing;
    if (currentSessionId) {
        ledger = mergeSession(ledger, {
            id: currentSessionId,
            state: STATE_OPEN,
            surface: SURFACE_CLI,
            firstSeenAt: now,
            lastSeenAt: now,
            source: SOURCE_NONE,
        }, now);
    }

    for (const parsed of parsedSessions) {
        ledger = mergeParsedSession(ledger, parsed, now);
    }
    for (const runtime of runtimeSessions) {
        ledger = mergeRuntimeSession(ledger, runtime, now);
    }

    ledger = autoCloseStaleSessions(ledger, now);
    return pruneLedger(ledger, now);
}

async function runtimeLedgerSessions(summaryPath) {
    try {
        return (await readRuntimeSessions(summaryPath))
            .map(runtimeLedgerPatch)
            .filter(Boolean);
    } catch {
        return [];
    }
}

function runtimeLedgerPatch(record) {
    const id = cleanId(record?.sessionId);
    const totalUsd = optNum(record?.officialTotalUsd) ?? optNum(record?.totalUsd);
    if (!id || totalUsd === undefined) {
        return undefined;
    }
    const at = optNum(record.lastTurnAt)
        ?? optNum(record.lastEndedAt)
        ?? optNum(record.lastStartedAt);
    return {
        id,
        totalNanoAiu: Math.round(totalUsd * NANO_AIU_PER_USD),
        at,
    };
}

function mergeRuntimeSession(ledger, runtime, now) {
    return mergeSession(ledger, {
        id: runtime.id,
        state: STATE_OPEN,
        surface: SURFACE_CLI,
        totalNanoAiu: runtime.totalNanoAiu,
        source: SOURCE_RUNTIME,
        lastSeenAt: runtime.at ?? now,
        windowAt: runtime.at ?? now,
        lastUpdatedAt: now,
    }, now);
}

function shouldParseSessionFile(prior, file, { currentSessionId, now }) {
    const isCurrent = file.id === currentSessionId;
    if (!isCurrent && file.latestEventAt < now - RETENTION_MS) {
        return false;
    }
    if (!prior) {
        return true;
    }
    if (!isCurrent && shouldSkipTrustedSession(prior, file, now)) {
        return false;
    }
    return eventFileChanged(prior, file);
}

async function latestSessionEventAt(path) {
    let handle;
    try {
        handle = await open(path, "r");
        const { size } = await handle.stat();
        const length = Math.min(size, LAST_EVENT_TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        const raw = buffer.toString("utf8");
        const lines = raw.trimEnd().split(/\r?\n/);
        for (let index = lines.length - 1; index >= 0; index -= 1) {
            const line = lines[index].trim();
            if (!line || (index === 0 && size > length)) {
                continue;
            }
            try {
                return timestampMs(JSON.parse(line).timestamp);
            } catch {
                continue;
            }
        }
        return undefined;
    } catch (error) {
        if (error?.code === "ENOENT") {
            return undefined;
        }
        throw error;
    } finally {
        await handle?.close();
    }
}

function eventFileChanged(prior, file) {
    const priorSize = optNum(prior.eventFileSize);
    const priorMtime = optNum(prior.eventFileMtimeMs);
    return priorSize === undefined
        || priorMtime === undefined
        || priorSize !== file.size
        || Math.abs(priorMtime - file.mtimeMs) > 1;
}

function cleanId(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function shouldParseVsCodeSession(prior, parsed, now) {
    const seenAt = optNum(parsed.lastSeenAt) ?? optNum(parsed.eventFileMtimeMs);
    if (seenAt !== undefined && seenAt < now - RETENTION_MS) {
        return false;
    }
    if (!prior) {
        return true;
    }
    if (shouldSkipTrustedSession(prior, parsed, now)) {
        return false;
    }
    return eventFileChanged(prior, parsed);
}

function shouldSkipTrustedSession(session, file, now) {
    return (isFinalizedSession(session) || isStaleOpenSession(session, now))
        && !eventFileChanged(session, file);
}

function isFinalizedSession(session = {}) {
    if (session.state === STATE_AUTO_CLOSED) {
        return true;
    }
    return session.state === STATE_CLOSED
        && [SOURCE_SHUTDOWN, SOURCE_MODEL_METRICS].includes(session.source);
}

function isStaleOpenSession(session = {}, now) {
    const lastSeenAt = optNum(session.lastSeenAt);
    return session.state === STATE_OPEN
        && lastSeenAt !== undefined
        && now - lastSeenAt >= 7 * DAY_MS;
}

export async function discoverSessionEventFiles(root = sessionStateRootPath()) {
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
        if (!entry.isDirectory()) {
            continue;
        }
        const path = join(root, entry.name, "events.jsonl");
        try {
            const file = await stat(path);
            files.push({ id: entry.name, path, mtimeMs: file.mtimeMs, size: file.size });
        } catch (error) {
            if (error?.code !== "ENOENT") {
                throw error;
            }
        }
    }
    return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

export function mergeParsedSession(ledger, parsed, now = Date.now()) {
    const id = parsed?.id;
    if (!id) {
        return ledger;
    }

    const common = {
        id,
        surface: parsed.surface ?? SURFACE_CLI,
        firstSeenAt: parsed.firstSeenAt,
        lastSeenAt: parsed.lastSeenAt,
        lastScannedAt: now,
        eventFileMtimeMs: parsed.eventFileMtimeMs,
        eventFileSize: parsed.eventFileSize,
        usageNanoAiu: parsed.usageNanoAiu,
        modelNanoAiu: parsed.modelNanoAiu,
        compactionNanoAiu: parsed.compactionNanoAiu,
        shutdownType: parsed.shutdownType,
        tokenTotals: parsed.tokenTotals,
        modelMetrics: parsed.modelMetrics,
    };
    if (parsed.sawShutdown || parsed.shutdownType || optNum(parsed.totalNanoAiu) !== undefined || optNum(parsed.modelNanoAiu) !== undefined) {
        return mergeSession(closeFromShutdown(ledger, {
            ...common,
            totalNanoAiu: parsed.totalNanoAiu,
            modelNanoAiu: parsed.modelNanoAiu,
            shutdownType: parsed.shutdownType,
            at: parsed.lastSeenAt ?? now,
        }), common, now);
    }

    const prePricing = isPrePricingSession(parsed);
    const partial = prePricing ? { source: SOURCE_NONE, totalNanoAiu: undefined } : partialNanoAiu(parsed);
    return mergeSession(ledger, {
        ...common,
        state: STATE_OPEN,
        totalNanoAiu: partial.totalNanoAiu,
        source: partial.source,
        lastUpdatedAt: partial.totalNanoAiu === undefined ? now : undefined,
    }, now);
}

export function currentSessionId(session = {}) {
    return stringValue(session.sessionId)
        ?? stringValue(session.session_id)
        ?? stringValue(session.id)
        ?? sessionStatePathId(session.workspacePath);
}

function partialNanoAiu(parsed) {
    const usageNanoAiu = optNum(parsed.usageNanoAiu);
    const compactionNanoAiu = optNum(parsed.compactionNanoAiu);
    const totalNanoAiu = sumOptional([usageNanoAiu, compactionNanoAiu]);
    if (totalNanoAiu === undefined) {
        return { source: SOURCE_NONE, totalNanoAiu: undefined };
    }
    return {
        source: usageNanoAiu !== undefined ? SOURCE_USAGE_EVENTS : SOURCE_COMPACTION,
        totalNanoAiu,
    };
}

function isPrePricingSession(parsed) {
    const at = optNum(parsed?.lastSeenAt) ?? optNum(parsed?.firstSeenAt);
    return at !== undefined && at < HISTORY.moneyPricingStartedAt;
}

function sumOptional(values) {
    let total = 0;
    let found = false;
    for (const value of values) {
        if (value !== undefined) {
            total += value;
            found = true;
        }
    }
    return found ? total : undefined;
}

function sessionStatePathId(workspacePath) {
    const value = stringValue(workspacePath);
    return value && basename(dirname(value)) === "session-state" ? basename(value) : undefined;
}

function stringValue(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
