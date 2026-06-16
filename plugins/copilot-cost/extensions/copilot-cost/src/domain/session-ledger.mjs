// Maintains the compact per-session cost ledger that backs rolling windows.

import { BILLING, HISTORY } from "../config.mjs";
import { readJson, updateJson } from "../io.mjs";
import { optNum } from "../math.mjs";
import { sessionLedgerPath } from "../storage.mjs";
import {
    builtInModelRates,
    normalizeModelName,
    tokenClassKeys,
} from "./model-pricing.mjs";

export const LEDGER_VERSION = 1;
export const STATE_OPEN = "open";
export const STATE_CLOSED = "closed";
export const STATE_AUTO_CLOSED = "auto_closed";
export const SOURCE_NONE = "none";
export const SOURCE_ESTIMATED_TOKENS = "estimated_tokens";
export const SOURCE_USAGE_EVENTS = "usage_events";
export const SOURCE_COMPACTION = "compaction";
export const SOURCE_RUNTIME = "runtime";
export const SOURCE_STATUSLINE = "statusline";
export const SOURCE_MODEL_METRICS = "modelMetrics";
export const SOURCE_SHUTDOWN = "shutdown";
export const SURFACE_CLI = "cli";
export const SURFACE_VSCODE = "vscode";

const DAY_MS = 24 * 60 * 60 * 1000;
const AUTO_CLOSE_MS = 7 * DAY_MS;
const RETENTION_MS = HISTORY.retentionDays * DAY_MS;
const AI_CREDIT_STARTED_AT = HISTORY.moneyPricingStartedAt;
const SOURCE_RANK = {
    [SOURCE_NONE]: 0,
    [SOURCE_ESTIMATED_TOKENS]: 1,
    [SOURCE_COMPACTION]: 2,
    [SOURCE_USAGE_EVENTS]: 2,
    [SOURCE_RUNTIME]: 3,
    [SOURCE_STATUSLINE]: 3,
    [SOURCE_MODEL_METRICS]: 4,
    [SOURCE_SHUTDOWN]: 5,
};
const RATE_PROFILE_SOURCES = new Set([SOURCE_SHUTDOWN, SOURCE_MODEL_METRICS, SOURCE_USAGE_EVENTS]);
const AUTHORITATIVE_RATE_PROFILE_SOURCES = new Set([SOURCE_SHUTDOWN, SOURCE_MODEL_METRICS]);
const WINDOW_DURATIONS = {
    window24hUsd: DAY_MS,
    window7dUsd: 7 * DAY_MS,
    window30dUsd: 30 * DAY_MS,
};

export async function readSessionLedger(path = sessionLedgerPath()) {
    return normalizeLedger(await readJson(path));
}

export async function updateSessionLedger(updater, path = sessionLedgerPath()) {
    return updateJson(path, async (ledger) => normalizeLedger(await updater(normalizeLedger(ledger))));
}

export function normalizeLedger(value = {}) {
    const sessions = {};
    for (const [id, session] of Object.entries(value?.sessions ?? {})) {
        const normalized = normalizeSession({ id, ...session });
        if (normalized) {
            sessions[normalized.id] = normalized;
        }
    }
    return {
        version: LEDGER_VERSION,
        lastSyncAt: optNum(value?.lastSyncAt),
        sessions,
    };
}

export function mergeSession(ledger, patch = {}, now = Date.now()) {
    const id = cleanId(patch.id);
    if (!id) {
        return normalizeLedger(ledger);
    }

    const next = normalizeLedger(ledger);
    const prior = next.sessions[id] ?? { id, state: null, source: SOURCE_NONE, surface: inferSurface(id) };
    const merged = mergeSessionRecord(prior, { ...patch, id }, now);
    next.sessions[id] = merged;
    next.lastSyncAt = now;
    return next;
}

export function markOpen(ledger, id, now = Date.now(), patch = {}) {
    return mergeSession(ledger, {
        ...patch,
        id,
        state: STATE_OPEN,
        surface: patch.surface ?? inferSurface(id),
        firstSeenAt: patch.firstSeenAt ?? now,
        lastSeenAt: patch.lastSeenAt ?? now,
        source: patch.source ?? SOURCE_NONE,
    }, now);
}

export function closeFromShutdown(ledger, { id, totalNanoAiu, modelNanoAiu, modelMetrics, shutdownType, at = Date.now() } = {}) {
    const total = optNum(totalNanoAiu) ?? optNum(modelNanoAiu);
    return mergeSession(ledger, {
        id,
        state: STATE_CLOSED,
        surface: inferSurface(id),
        totalNanoAiu: total,
        source: optNum(totalNanoAiu) !== undefined ? SOURCE_SHUTDOWN : SOURCE_MODEL_METRICS,
        shutdownType,
        modelMetrics,
        closedAt: at,
        lastSeenAt: at,
        lastUpdatedAt: at,
    }, at);
}

export function autoCloseStaleSessions(ledger, now = Date.now()) {
    const profiles = rateProfiles(ledger);
    let next = normalizeLedger(ledger);
    for (const session of Object.values(next.sessions)) {
        if (session.state !== STATE_OPEN || !isStale(session, now)) {
            continue;
        }
        const observedTotal = observedPartialNanoAiu(session);
        const observedPlusEstimate = estimateUnpricedRemainder(session, profiles, observedTotal);
        if (observedPlusEstimate) {
            next = mergeSession(next, {
                id: session.id,
                state: STATE_AUTO_CLOSED,
                totalNanoAiu: observedPlusEstimate.totalNanoAiu,
                source: SOURCE_ESTIMATED_TOKENS,
                estimateConfidence: "low",
                estimateModel: observedPlusEstimate.model,
                forceTotal: true,
                lastUpdatedAt: now,
            }, now);
            continue;
        }

        const total = storedCurrentPricingNanoAiu(session);
        if (total !== undefined) {
            next = mergeSession(next, {
                id: session.id,
                state: STATE_AUTO_CLOSED,
                totalNanoAiu: total,
                source: session.source,
                lastUpdatedAt: session.lastUpdatedAt ?? now,
            }, now);
            continue;
        }

        const estimate = estimateFromTokens(session, profiles);
        next = mergeSession(next, {
            id: session.id,
            state: STATE_AUTO_CLOSED,
            totalNanoAiu: estimate?.totalNanoAiu,
            source: estimate ? SOURCE_ESTIMATED_TOKENS : SOURCE_NONE,
            estimateConfidence: estimate ? "low" : undefined,
            estimateModel: estimate?.model,
            forceTotal: isPreCreditSession(session),
            lastUpdatedAt: now,
        }, now);
    }
    return next;
}

export function pruneLedger(ledger, now = Date.now()) {
    const cutoff = now - RETENTION_MS;
    const normalized = normalizeLedger(ledger);
    return {
        ...normalized,
        sessions: Object.fromEntries(Object.entries(normalized.sessions)
            .filter(([, session]) => retainedSession(session, cutoff))),
    };
}

export function sessionLedgerWindows(ledger, now = Date.now()) {
    const events = ledgerUsageEvents(ledger, now);
    return {
        window24hUsd: sumSince(events, now - WINDOW_DURATIONS.window24hUsd),
        window7dUsd: sumSince(events, now - WINDOW_DURATIONS.window7dUsd),
        window30dUsd: sumSince(events, now - WINDOW_DURATIONS.window30dUsd),
    };
}

export function ledgerUsageEvents(ledger, now = Date.now(), { includePreCredit = true } = {}) {
    const retentionCutoff = now - RETENTION_MS;
    const cutoff = includePreCredit ? retentionCutoff : Math.max(retentionCutoff, AI_CREDIT_STARTED_AT);
    const normalized = normalizeLedger(ledger);
    const profiles = rateProfiles(normalized);
    return Object.values(normalized.sessions)
        .map((session) => {
            const at = bucketTimestamp(session);
            const totalNanoAiu = currentPricingNanoAiu(session, profiles);
            return at !== undefined && totalNanoAiu > 0 ? { at, usd: nanoAiuToUsd(totalNanoAiu), id: session.id } : null;
        })
        .filter(Boolean)
        .filter((event) => event.at >= cutoff && event.at <= now);
}

export function nanoAiuToUsd(nanoAiu) {
    return (optNum(nanoAiu) ?? 0) / BILLING.nanoAiuPerAiCredit * BILLING.usdPerAiCredit;
}

function mergeSessionRecord(prior, patch, now) {
    const next = { ...prior };
    const priorTotal = optNum(prior.totalNanoAiu);
    const patchTotal = optNum(patch.totalNanoAiu);
    const priorSource = prior.source ?? SOURCE_NONE;
    const patchSource = patch.source ?? priorSource;
    const shouldReplaceTotal = patchTotal !== undefined && (patch.forceTotal === true || sourceRank(patchSource) >= sourceRank(priorSource));

    next.id = cleanId(patch.id) ?? prior.id;
    next.state = mergeState(prior.state, patch.state);
    next.surface = normalizeSurface(patch.surface) ?? normalizeSurface(prior.surface) ?? inferSurface(next.id);
    next.source = shouldReplaceTotal ? patchSource : priorSource;
    if (shouldReplaceTotal) {
        next.totalNanoAiu = patchTotal;
    } else if (priorTotal !== undefined) {
        next.totalNanoAiu = priorTotal;
    }

    mergeOptional(next, patch, [
        "firstSeenAt",
        "lastSeenAt",
        "closedAt",
        "lastScannedAt",
        "eventFileMtimeMs",
        "eventFileSize",
        "usageNanoAiu",
        "modelNanoAiu",
        "compactionNanoAiu",
        "estimateConfidence",
        "estimateModel",
        "shutdownType",
        "windowAt",
    ]);
    next.firstSeenAt = minDefined(optNum(prior.firstSeenAt), optNum(patch.firstSeenAt));
    next.lastSeenAt = maxDefined(optNum(prior.lastSeenAt), optNum(patch.lastSeenAt));
    next.closedAt = patch.state === STATE_CLOSED ? optNum(patch.closedAt) ?? optNum(patch.lastSeenAt) ?? now : optNum(next.closedAt);
    next.lastUpdatedAt = materialChange(prior, next, patch) ? optNum(patch.lastUpdatedAt) ?? now : optNum(prior.lastUpdatedAt);
    if (patch.tokenTotals) {
        next.tokenTotals = mergeTokenTotals(prior.tokenTotals, patch.tokenTotals);
    }
    if (patch.modelMetrics) {
        next.modelMetrics = mergeModelMetrics(prior.modelMetrics, patch.modelMetrics);
    }
    if (next.source !== SOURCE_ESTIMATED_TOKENS) {
        next.estimateConfidence = undefined;
        next.estimateModel = undefined;
    }
    return dropUndefined(next);
}

function normalizeSession(session) {
    const id = cleanId(session.id);
    if (!id) {
        return undefined;
    }
    return dropUndefined({
        id,
        state: normalizeState(session.state),
        surface: normalizeSurface(session.surface) ?? inferSurface(id),
        totalNanoAiu: optNum(session.totalNanoAiu),
        source: normalizeSource(session.source),
        firstSeenAt: optNum(session.firstSeenAt),
        lastSeenAt: optNum(session.lastSeenAt),
        lastUpdatedAt: optNum(session.lastUpdatedAt),
        closedAt: optNum(session.closedAt),
        lastScannedAt: optNum(session.lastScannedAt),
        eventFileMtimeMs: optNum(session.eventFileMtimeMs),
        eventFileSize: optNum(session.eventFileSize),
        usageNanoAiu: optNum(session.usageNanoAiu),
        modelNanoAiu: optNum(session.modelNanoAiu),
        compactionNanoAiu: optNum(session.compactionNanoAiu),
        estimateConfidence: session.estimateConfidence,
        estimateModel: session.estimateModel,
        shutdownType: stringValue(session.shutdownType),
        windowAt: optNum(session.windowAt),
        tokenTotals: normalizeTokenTotals(session.tokenTotals),
        modelMetrics: normalizeModelMetrics(session.modelMetrics),
    });
}

function mergeState(prior, next) {
    const state = normalizeState(next);
    if (!state) {
        return normalizeState(prior);
    }
    if (normalizeState(prior) === STATE_CLOSED && state !== STATE_CLOSED) {
        return STATE_CLOSED;
    }
    return state;
}

function normalizeState(value) {
    return [STATE_OPEN, STATE_CLOSED, STATE_AUTO_CLOSED].includes(value) ? value : null;
}

function normalizeSource(value) {
    return Object.hasOwn(SOURCE_RANK, value) ? value : SOURCE_NONE;
}

function normalizeSurface(value) {
    return [SURFACE_CLI, SURFACE_VSCODE].includes(value) ? value : undefined;
}

function inferSurface(id) {
    return cleanId(id)?.startsWith(`${SURFACE_VSCODE}:`) ? SURFACE_VSCODE : SURFACE_CLI;
}

function sourceRank(source) {
    return SOURCE_RANK[normalizeSource(source)] ?? 0;
}

function isStale(session, now) {
    const lastSeenAt = optNum(session.lastSeenAt);
    return lastSeenAt !== undefined && now - lastSeenAt >= AUTO_CLOSE_MS;
}

function estimateFromTokens(session, profiles) {
    const modelMetrics = normalizeModelMetrics(session.modelMetrics);
    let totalNanoAiu = 0;
    let model;
    for (const [name, metrics] of Object.entries(modelMetrics)) {
        const estimate = estimateTokenTotals(name, metrics.tokenTotals, profiles);
        if (estimate > 0) {
            totalNanoAiu += estimate;
            model ??= name;
        }
    }
    return totalNanoAiu > 0 ? { totalNanoAiu: Math.round(totalNanoAiu), model: model ?? "global" } : undefined;
}

function estimateUnpricedRemainder(session, profiles, observedTotal) {
    const observed = optNum(observedTotal);
    if (observed === undefined) {
        return undefined;
    }

    const modelMetrics = normalizeModelMetrics(session.modelMetrics);
    let estimatedNanoAiu = 0;
    let model;
    for (const [name, metrics] of Object.entries(modelMetrics)) {
        if (optNum(metrics.totalNanoAiu) !== undefined) {
            continue;
        }
        const estimate = estimateTokenTotals(name, metrics.tokenTotals, profiles);
        if (estimate > 0) {
            estimatedNanoAiu += estimate;
            model ??= name;
        }
    }
    return estimatedNanoAiu > 0
        ? { totalNanoAiu: Math.round(observed + estimatedNanoAiu), model: model ?? "global" }
        : undefined;
}

function rateProfiles(ledger) {
    const byModel = {};
    for (const session of Object.values(normalizeLedger(ledger).sessions)) {
        if (isPreCreditSession(session)) {
            continue;
        }
        if (!RATE_PROFILE_SOURCES.has(session.source)) {
            continue;
        }
        const authoritative = AUTHORITATIVE_RATE_PROFILE_SOURCES.has(session.source);
        for (const [model, metrics] of Object.entries(normalizeModelMetrics(session.modelMetrics))) {
            const nano = optNum(metrics.totalNanoAiu);
            const tokenClass = singleTokenClass(metrics.tokenTotals);
            const tokens = optNum(metrics.tokenTotals?.[tokenClass]);
            if (nano > 0 && tokens > 0) {
                const key = normalizeModelName(model);
                const current = byModel[key] ?? {};
                let bucket = current[tokenClass] ?? { nano: 0, tokens: 0, authoritative: false };
                if (authoritative && !bucket.authoritative) {
                    bucket = { nano: 0, tokens: 0, authoritative: true };
                }
                if (!authoritative && bucket.authoritative) {
                    continue;
                }
                bucket.nano += nano;
                bucket.tokens += tokens;
                current[tokenClass] = bucket;
                byModel[key] = current;
            }
        }
    }
    return {
        byModel: Object.fromEntries(Object.entries(byModel).map(([model, rates]) => [
            model,
            Object.fromEntries(Object.entries(rates)
                .filter(([, value]) => value.tokens > 0)
                .map(([key, value]) => [key, value.nano / value.tokens])),
        ])),
    };
}

function estimateTokenTotals(model, tokens = {}, profiles) {
    const observed = profiles.byModel[normalizeModelName(model)] ?? {};
    const builtIn = builtInModelRates(model, tokens) ?? {};
    const billable = billableTokenTotals(tokens);
    return tokenClassKeys(billable).reduce((total, key) => {
        const rate = observed[key] ?? builtIn[key];
        const count = optNum(billable?.[key]);
        return rate !== undefined && count > 0 ? total + count * rate : total;
    }, 0);
}

function billableTokenTotals(tokens = {}) {
    const inputTokens = optNum(tokens.inputTokens);
    const cacheReadTokens = optNum(tokens.cacheReadTokens);
    const cacheWriteTokens = optNum(tokens.cacheWriteTokens);
    const billable = {
        cacheReadTokens,
        cacheWriteTokens,
        outputTokens: optNum(tokens.outputTokens),
        reasoningTokens: optNum(tokens.reasoningTokens),
    };
    if (inputTokens !== undefined) {
        billable.inputTokens = Math.max(0, inputTokens - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0));
    }
    return billable;
}

function singleTokenClass(tokens = {}) {
    const keys = tokenClassKeys(tokens);
    return keys.length === 1 ? keys[0] : undefined;
}

function bucketTimestamp(session) {
    return optNum(session.windowAt)
        ?? optNum(session.closedAt)
        ?? optNum(session.lastSeenAt)
        ?? optNum(session.lastUpdatedAt);
}

function retainedSession(session, cutoff) {
    const at = bucketTimestamp(session)
        ?? optNum(session.firstSeenAt)
        ?? optNum(session.lastScannedAt);
    return at === undefined || at >= cutoff;
}

function currentPricingNanoAiu(session, profiles) {
    if (session.source === SOURCE_ESTIMATED_TOKENS) {
        const estimate = estimateFromTokens(session, profiles);
        return estimate?.totalNanoAiu ?? optNum(session.totalNanoAiu);
    }
    if (!isPreCreditSession(session)) {
        return positiveNanoAiu(session.totalNanoAiu)
            ?? positiveNanoAiu(sumModelMetricsNanoAiu(session.modelMetrics))
            ?? (session.state === STATE_OPEN ? undefined : estimateFromTokens(session, profiles)?.totalNanoAiu)
            ?? optNum(session.totalNanoAiu);
    }

    const estimate = estimateFromTokens(session, profiles);
    if (estimate) {
        return estimate.totalNanoAiu;
    }
    return undefined;
}

function storedCurrentPricingNanoAiu(session) {
    if (!isPreCreditSession(session)) {
        return optNum(session.totalNanoAiu);
    }
    return session.source === SOURCE_ESTIMATED_TOKENS ? optNum(session.totalNanoAiu) : undefined;
}

function observedPartialNanoAiu(session) {
    if (isPreCreditSession(session)) {
        return undefined;
    }
    const source = normalizeSource(session.source);
    if (![SOURCE_USAGE_EVENTS, SOURCE_COMPACTION].includes(source)) {
        return undefined;
    }
    const total = sumOptional([session.usageNanoAiu, session.compactionNanoAiu]);
    return total ?? optNum(session.totalNanoAiu);
}

function sumModelMetricsNanoAiu(modelMetrics = {}) {
    return sumOptional(Object.values(normalizeModelMetrics(modelMetrics)).map((metrics) => metrics.totalNanoAiu));
}

function positiveNanoAiu(value) {
    const nano = optNum(value);
    return nano > 0 ? nano : undefined;
}

function isPreCreditSession(session) {
    const at = bucketTimestamp(session);
    return at !== undefined && at < AI_CREDIT_STARTED_AT;
}

function sumSince(events, cutoff) {
    return events.filter((event) => event.at >= cutoff).reduce((sum, event) => sum + event.usd, 0);
}

function mergeOptional(target, patch, keys) {
    for (const key of keys) {
        if (patch[key] !== undefined) {
            target[key] = patch[key];
        }
    }
}

function mergeTokenTotals(prior, patch) {
    const keys = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "requestCount", "requestCostUnits"];
    const next = { ...normalizeTokenTotals(prior) };
    for (const key of keys) {
        const value = optNum(patch?.[key]);
        if (value !== undefined) {
            next[key] = value;
        }
    }
    return dropUndefined(next);
}

function normalizeTokenTotals(value) {
    if (!value || typeof value !== "object") {
        return undefined;
    }
    return dropUndefined({
        inputTokens: optNum(value.inputTokens),
        cacheReadTokens: optNum(value.cacheReadTokens),
        cacheWriteTokens: optNum(value.cacheWriteTokens),
        outputTokens: optNum(value.outputTokens),
        reasoningTokens: optNum(value.reasoningTokens),
        requestCount: optNum(value.requestCount),
        requestCostUnits: optNum(value.requestCostUnits),
    });
}

function mergeModelMetrics(prior, patch) {
    const next = { ...normalizeModelMetrics(prior) };
    for (const [model, metrics] of Object.entries(normalizeModelMetrics(patch))) {
        const existing = next[model] ?? {};
        next[model] = dropUndefined({
            totalNanoAiu: metrics.totalNanoAiu ?? existing.totalNanoAiu,
            tokenTotals: metrics.tokenTotals ?? existing.tokenTotals,
        });
    }
    return normalizeModelMetrics(next);
}

function normalizeModelMetrics(value) {
    if (!value || typeof value !== "object") {
        return {};
    }
    const entries = Object.entries(value)
        .map(([model, metrics]) => [model, dropUndefined({
            totalNanoAiu: optNum(metrics?.totalNanoAiu),
            tokenTotals: normalizeTokenTotals(metrics?.tokenTotals),
        })])
        .filter(([model]) => cleanId(model));
    return Object.fromEntries(entries);
}

function materialChange(prior, next, patch) {
    return normalizeState(prior.state) !== normalizeState(next.state)
        || optNum(prior.totalNanoAiu) !== optNum(next.totalNanoAiu)
        || normalizeSource(prior.source) !== normalizeSource(next.source)
        || normalizeSurface(prior.surface) !== normalizeSurface(next.surface)
        || patch.lastUpdatedAt !== undefined
        || patch.estimateConfidence !== undefined;
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

function cleanId(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringValue(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value) {
    return optNum(value) ?? 0;
}

function sumOptional(values) {
    let total = 0;
    let found = false;
    for (const value of values) {
        const number = optNum(value);
        if (number !== undefined) {
            total += number;
            found = true;
        }
    }
    return found ? total : undefined;
}

function dropUndefined(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
