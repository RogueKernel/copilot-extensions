// Converts Copilot usage payloads into persisted cost state and next-turn estimates.
// Official-vs-pending reconciliation is intentional: local assistant.usage can
// miss some host/tool-side work, so statusline ai_used.total_nano_aiu must
// reconcile Total and rolling deltas instead of being displayed as Sess-only
// data. Sub-agent lifecycle events are filtered for timing/context, while usage
// events are still accumulated when emitted.

import { BILLING } from "../config.mjs";
import { num, optNum, pct } from "../math.mjs";
import { isCacheReadToken, isCacheWriteToken, isInputToken, isOutputToken, measureRate } from "./rates.mjs";

// Records locally observed turn cost while official AI-Credit totals lag behind.
export function snapshotTurn(turn, priorState = {}, contextWindow = {}) {
    const prior = new CostState(priorState);
    const lastUsd = toUsd(turn.nanoAiu);
    const pendingLastUsd = Math.max(0, lastUsd - officialTurnDelta(turn, prior));
    const officialTotalUsd = prior.accepted;
    const pendingUsd = prior.pending + pendingLastUsd;
    return dropUndefined({
        lastNanoAiu: turn.nanoAiu,
        lastUsd,
        pendingUsd,
        officialTotalUsd,
        totalUsd: officialTotalUsd + pendingUsd,
        tokens: turn.input + turn.output,
        contextTokens: optNum(contextWindow.currentTokens),
        contextTokenLimit: optNum(contextWindow.tokenLimit),
        cacheReadPercent: pct(turn.cacheRead, turn.input),
        cacheWritePercent: pct(turn.pricedCacheWrite, turn.input),
        hasCacheWrite: turn.pricedCacheWrite > 0,
        inputNanoPerToken: turn.inputNanoPerToken,
        cacheReadNanoPerToken: turn.cacheReadNanoPerToken,
        cacheWriteNanoPerToken: turn.cacheWriteNanoPerToken,
        outputNanoPerToken: turn.outputNanoPerToken,
        newWorkSamples: appendSample(priorState.newWorkSamples, workSample(turn)),
        lastStartedAt: turn.startedAt,
        lastEndedAt: turn.endedAt,
        lastDurationMs: durationMs(turn),
        lastTurnAt: turn.endedAt,
        partial: turn.partial,
    });
}

// Reconciles the durable state with the statusline's official cumulative total.
export function snapshotStatus(status, priorState = {}) {
    const prior = new CostState(priorState);
    const reportedUsd = official(status);
    const reconciled = reconcileOfficial(prior, reportedUsd);
    const pendingUsd = reconciled.reset ? 0 : Math.max(0, prior.pending - reconciled.deltaUsd);
    const officialTotalUsd = reconciled.carryUsd + reconciled.currentUsd;
    return dropUndefined({
        sessionUsd: sessionUsd(status),
        carryUsd: reconciled.carryUsd,
        officialSegmentUsd: reconciled.currentUsd,
        officialTotalUsd,
        pendingUsd,
        totalUsd: officialTotalUsd + pendingUsd,
        contextTokens: contextTokens(status.context_window),
        contextTokenLimit: contextLimit(status.context_window),
    });
}

// Adds compaction usage into pending cost because it arrives outside a normal turn.
export function snapshotCompaction(compaction, priorState = {}) {
    const usage = compaction.compactionTokensUsed;
    const usd = compactionUsd(compaction);
    const prior = new CostState(priorState);
    const officialTotalUsd = prior.accepted;
    const pendingUsd = prior.pending + usd;
    return dropUndefined({
        officialTotalUsd,
        pendingUsd,
        totalUsd: officialTotalUsd + pendingUsd,
        contextTokens: optNum(compaction.contextWindow?.currentTokens) ?? optNum(compaction.postCompactionTokens),
        contextTokenLimit: optNum(compaction.contextWindow?.tokenLimit),
        inputNanoPerToken: measureRate(usage, isInputToken),
        cacheReadNanoPerToken: measureRate(usage, isCacheReadToken),
        cacheWriteNanoPerToken: measureRate(usage, isCacheWriteToken),
        outputNanoPerToken: measureRate(usage, isOutputToken),
    });
}

// Estimates the next request as a warm-cache lower bound and cold-cache upper bound.
export function estimateNext(cost = {}) {
    const tokens = optNum(cost.contextTokens);
    const cachedRate = optNum(cost.cacheReadNanoPerToken);
    const inputRate = optNum(cost.inputNanoPerToken);
    const lowerRate = cachedRate !== undefined && inputRate !== undefined ? blend(cachedRate, inputRate) : inputRate;
    const upperRate = optNum(cost.cacheWriteNanoPerToken) ?? inputRate;
    if (tokens === undefined || lowerRate === undefined || upperRate === undefined) {
        return undefined;
    }

    const newWorkUsd = averageNewWorkUsd(cost);
    return { lowerUsd: toUsd(tokens * lowerRate) + newWorkUsd, upperUsd: toUsd(tokens * upperRate) + newWorkUsd };
}

// Returns the best-known total displayed to users.
export function total(state = {}) {
    return new CostState(state).total;
}

// Returns the official total already accepted into persisted state.
export function officialTotal(state = {}) {
    return new CostState(state).accepted;
}

// Returns the newly observed official usage amount from a statusline payload.
export function officialUsageDelta(status, priorState = {}) {
    const reportedUsd = official(status);
    if (reportedUsd === undefined) {
        return 0;
    }

    const currentUsd = new CostState(priorState).segment;
    // A drop below the known segment means the official counter reset, so the
    // whole reported amount is fresh usage rather than a delta.
    return reportedUsd < currentUsd ? reportedUsd : Math.max(0, reportedUsd - currentUsd);
}

// Converts nano-AIU values into USD using the fixed AI-Credit exchange rate.
export function toUsd(nanoAiu) {
    return (num(nanoAiu) / BILLING.nanoAiuPerAiCredit) * BILLING.usdPerAiCredit;
}

// Returns the observed compaction cost, or zero when the host omitted it.
export function compactionUsd(compaction = {}) {
    return toUsd(optNum(compaction.compactionTokensUsed?.copilotUsage?.totalNanoAiu));
}

// A read model over the persisted cost record. Wrapping the plain JSON record in
// one place keeps the official-vs-pending accessors grouped together, without
// giving the durable state an identity or lifecycle it does not own: callers
// construct a fresh view per call and still persist plain objects.
class CostState {
    constructor(record = {}) {
        this.record = record;
    }

    // Official cost already banked from earlier billing segments.
    get carried() {
        return num(this.record.carryUsd);
    }

    // Official cost reported for the current billing segment.
    get segment() {
        return num(optNum(this.record.officialSegmentUsd) ?? optNum(this.record.officialTotalUsd));
    }

    // Locally tracked cost not yet reflected in the official total.
    get pending() {
        const pending = optNum(this.record.pendingUsd);
        if (pending !== undefined) {
            return pending;
        }
        // Broken prerelease states may have only totalUsd. Preserve that as
        // local pending work until the official session total catches up.
        return this.hasOfficialFields ? 0 : num(this.record.totalUsd);
    }

    // Official cost reconciled into the durable total so far.
    get accepted() {
        return this.carried + this.segment;
    }

    // Best-known total displayed to users, or undefined before any usage.
    get total() {
        return optNum(this.record.totalUsd) ?? optNum(this.record.officialTotalUsd);
    }

    get hasOfficialFields() {
        return optNum(this.record.carryUsd) !== undefined
            || optNum(this.record.officialSegmentUsd) !== undefined
            || optNum(this.record.officialTotalUsd) !== undefined;
    }
}

// Folds a freshly reported official total into the running segment. A reported
// value below the current segment means the official counter rewound, so the
// prior display total is banked into carry and the segment restarts.
function reconcileOfficial(state, reportedUsd) {
    const carry = state.carried;
    const current = state.segment;
    if (reportedUsd === undefined) {
        return { carryUsd: carry, currentUsd: current, deltaUsd: 0, reset: false };
    }
    if (reportedUsd < current) {
        return { carryUsd: state.total ?? state.accepted, currentUsd: reportedUsd, deltaUsd: 0, reset: true };
    }
    return { carryUsd: carry, currentUsd: reportedUsd, deltaUsd: reportedUsd - current, reset: false };
}

// Converts the statusline's cumulative official AIU into USD, if present.
function official(status = {}) {
    const nanoAiu = optNum(status.ai_used?.total_nano_aiu);
    return nanoAiu === undefined ? undefined : toUsd(nanoAiu);
}

// Converts the same official AIU total into a separate session display metric.
function sessionUsd(status = {}) {
    return official(status);
}

// Reads the current context size across the payload's many key spellings.
function contextTokens(contextWindow = {}) {
    return optNum(contextWindow.current_context_tokens)
        ?? optNum(contextWindow.currentTokens)
        ?? optNum(contextWindow.current_tokens)
        ?? optNum(contextWindow.total_tokens)
        ?? optNum(contextWindow.totalTokens);
}

// Reads the context limit, inferring it from used-percentage when no explicit
// limit field is present in the payload.
function contextLimit(contextWindow = {}) {
    const explicitLimit = optNum(contextWindow.displayed_context_limit)
        ?? optNum(contextWindow.max_context_window_tokens)
        ?? optNum(contextWindow.tokenLimit)
        ?? optNum(contextWindow.token_limit)
        ?? optNum(contextWindow.max_context_tokens)
        ?? optNum(contextWindow.maxTokens)
        ?? optNum(contextWindow.max_tokens)
        ?? optNum(contextWindow.context_window_size);
    if (explicitLimit !== undefined) {
        return explicitLimit;
    }

    const currentTokens = contextTokens(contextWindow);
    const usedPercent = optNum(contextWindow.current_context_used_percentage)
        ?? optNum(contextWindow.used_percentage);
    return currentTokens !== undefined && usedPercent !== undefined && usedPercent > 0
        ? Math.round(currentTokens / (usedPercent / 100))
        : undefined;
}

// Captures the uncached input and output tokens of one turn for trend estimates.
function workSample(turn) {
    return {
        inputTokens: Math.max(0, num(turn.input) - num(turn.cacheRead)),
        outputTokens: num(turn.output),
    };
}

// Wall-clock duration of a turn when both endpoints are known.
function durationMs(turn) {
    const startedAt = optNum(turn.startedAt);
    const endedAt = optNum(turn.endedAt);
    return startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : undefined;
}

// Official usage can catch up while a turn is still running. Only the part of
// the completed turn that is not already official should remain pending.
function officialTurnDelta(turn, prior) {
    const startedUsd = optNum(turn.officialStartedUsd);
    return startedUsd === undefined ? 0 : Math.max(0, prior.accepted - startedUsd);
}

// Appends a valid work sample and keeps only the most recent few.
function appendSample(samples, value) {
    const values = Array.isArray(samples) ? samples.filter(isWorkSample) : [];
    if (isWorkSample(value)) {
        values.push(value);
    }
    return values.slice(-BILLING.newWorkSampleLimit);
}

// Averages the retained work samples, treating an empty history as zero.
function averageSample(samples) {
    const values = Array.isArray(samples) ? samples.filter(isWorkSample) : [];
    if (!values.length) {
        return { inputTokens: 0, outputTokens: 0 };
    }

    return {
        inputTokens: values.reduce((sum, item) => sum + item.inputTokens, 0) / values.length,
        outputTokens: values.reduce((sum, item) => sum + item.outputTokens, 0) / values.length,
    };
}

// A work sample is usable only when both token counts are finite numbers.
function isWorkSample(value) {
    return optNum(value?.inputTokens) !== undefined && optNum(value?.outputTokens) !== undefined;
}

// Weights cached and uncached input rates by the expected cache-hit ratio.
function blend(cachedRate, inputRate) {
    return cachedRate * BILLING.cacheHitRatio + inputRate * (1 - BILLING.cacheHitRatio);
}

// Estimated USD for the average new (uncached) work added by the next turn.
function averageNewWorkUsd(cost = {}) {
    const work = averageSample(cost.newWorkSamples);
    return toUsd(work.inputTokens * num(cost.inputNanoPerToken)) + toUsd(work.outputTokens * num(cost.outputNanoPerToken));
}

// Drops absent keys so a patch never overwrites known state with undefined.
function dropUndefined(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
