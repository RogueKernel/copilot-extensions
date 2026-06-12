// Discovers local Copilot session telemetry and folds it into the session ledger.

import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
    autoCloseStaleSessions,
    closeFromShutdown,
    mergeSession,
    readSessionLedger,
    SOURCE_COMPACTION,
    SOURCE_NONE,
    SOURCE_USAGE_EVENTS,
    STATE_OPEN,
    updateSessionLedger,
} from "./session-ledger.mjs";
import { parseSessionEvents } from "./session-jsonl.mjs";
import { HISTORY } from "../config.mjs";
import { optNum } from "../math.mjs";
import { sessionLedgerPath, sessionStateRootPath } from "../storage.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = HISTORY.retentionDays * DAY_MS;

export async function syncSessionLedger({
    currentSessionId,
    sessionStateRoot = sessionStateRootPath(),
    ledgerPath = sessionLedgerPath(),
    now = Date.now(),
} = {}) {
    const snapshot = await readSessionLedger(ledgerPath);
    const parsedSessions = [];
    for (const file of await discoverSessionEventFiles(sessionStateRoot)) {
        const prior = snapshot.sessions[file.id];
        if (!shouldParseSessionFile(prior, file, { currentSessionId, now })) {
            continue;
        }
        parsedSessions.push(await parseSessionEvents(file.path, { id: file.id }));
    }

    return updateSessionLedger((existing) => syncSessionLedgerValue(existing, {
        currentSessionId,
        parsedSessions,
        now,
    }), ledgerPath);
}

function syncSessionLedgerValue(existing, { currentSessionId, parsedSessions, now }) {
    let ledger = existing;
    if (currentSessionId) {
        ledger = mergeSession(ledger, {
            id: currentSessionId,
            state: STATE_OPEN,
            firstSeenAt: now,
            lastSeenAt: now,
            source: SOURCE_NONE,
        }, now);
    }

    for (const parsed of parsedSessions) {
        ledger = mergeParsedSession(ledger, parsed, now);
    }

    ledger = autoCloseStaleSessions(ledger, now);
    return ledger;
}

function shouldParseSessionFile(prior, file, { currentSessionId, now }) {
    if (!prior) {
        return file.id === currentSessionId || file.mtimeMs >= now - RETENTION_MS;
    }
    return eventFileChanged(prior, file);
}

function eventFileChanged(prior, file) {
    const priorSize = optNum(prior.eventFileSize);
    const priorMtime = optNum(prior.eventFileMtimeMs);
    return priorSize === undefined
        || priorMtime === undefined
        || priorSize !== file.size
        || Math.abs(priorMtime - file.mtimeMs) > 1;
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
        firstSeenAt: parsed.firstSeenAt,
        lastSeenAt: parsed.lastSeenAt,
        lastScannedAt: now,
        eventFileMtimeMs: parsed.eventFileMtimeMs,
        eventFileSize: parsed.eventFileSize,
        usageNanoAiu: parsed.usageNanoAiu,
        modelNanoAiu: parsed.modelNanoAiu,
        compactionNanoAiu: parsed.compactionNanoAiu,
        tokenTotals: parsed.tokenTotals,
        modelMetrics: parsed.modelMetrics,
    };
    const prePricing = isPrePricingSession(parsed);
    if (!prePricing && (optNum(parsed.totalNanoAiu) !== undefined || optNum(parsed.modelNanoAiu) !== undefined)) {
        return mergeSession(closeFromShutdown(ledger, {
            ...common,
            totalNanoAiu: parsed.totalNanoAiu,
            modelNanoAiu: parsed.modelNanoAiu,
            at: parsed.lastSeenAt ?? now,
        }), common, now);
    }

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
