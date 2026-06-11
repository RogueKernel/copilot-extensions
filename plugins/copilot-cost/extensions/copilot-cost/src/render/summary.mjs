// Renders persisted cost state into after-message and statusline text.
// renderSummary is the public seam; the token map stays inside this module so
// custom formats do not leak into accounting code.

import { DISPLAY, STYLE } from "../config.mjs";
import { estimateNext, total, toUsd } from "../domain/cost.mjs";
import { num, optNum } from "../math.mjs";
import { formatAmount, formatClock, formatDuration, formatPercent, formatTokenCount, paint, renderFormat } from "./format.mjs";

// Renders one terminal line from persisted state.
export function renderSummary(cost = {}, options = {}) {
    const unit = options.unit ?? DISPLAY.defaultUnit;
    return renderUnitLine(cost, options, unit);
}

// Renders one summary line in the requested unit, falling back to the default format.
function renderUnitLine(cost = {}, options = {}, unit = DISPLAY.defaultUnit) {
    return renderFormat(options.format, lineTokens(cost, options.color, unit), options.color, DISPLAY.defaultFormat);
}

// Formats the last turn's duration, defaulting to "0s" when unknown.
function renderDuration(cost = {}) {
    const durationMs = lastDurationMs(cost);
    return durationMs === undefined ? "0s" : formatDuration(durationMs);
}

// Builds every user-visible placeholder listed in DISPLAY.formatTokens.
function lineTokens(cost = {}, color, unit = DISPLAY.defaultUnit) {
    const next = estimateNext(cost) ?? { lowerUsd: 0, upperUsd: 0 };
    const lastTime = renderLastTime(cost);
    const totalValue = formatAmount(total(cost), unit);
    const lastValue = formatAmount(lastTurnUsd(cost), unit, { signed: true });
    const sessionValue = formatAmount(cost.sessionUsd, unit, { precision: 1, rounding: "down" });
    const window24hValue = formatAmount(cost.window24hUsd, unit, { precision: 0, rounding: "down" });
    const window7dValue = formatAmount(cost.window7dUsd, unit, { precision: 0, rounding: "down" });
    const window30dValue = formatAmount(cost.window30dUsd, unit, { precision: 0, rounding: "down" });
    const lastDurationValue = renderDuration(cost);
    const nextCachedValue = formatAmount(next.lowerUsd, unit);
    const nextUncachedValue = formatAmount(next.upperUsd, unit);
    const contextUsedValue = formatTokenCount(cost.contextTokens, { fallback: "0" });
    const contextTotalValue = formatTokenCount(cost.contextTokenLimit, { fallback: "?" });
    const cacheReadValue = formatPercent(cost.cacheReadPercent);
    const cacheWriteValue = cost.hasCacheWrite ? formatPercent(cost.cacheWritePercent) : "";
    const totalCost = paint(totalValue, STYLE.total, color);
    const lastCost = paint(lastValue, STYLE.last, color);
    const sessionCost = paint(sessionValue, STYLE.windows, color);
    const window24h = paint(window24hValue, STYLE.windows, color);
    const window7d = paint(window7dValue, STYLE.windows, color);
    const window30d = paint(window30dValue, STYLE.windows, color);
    const lastDuration = paint(lastDurationValue, STYLE.text, color);
    const nextCached = paint(nextCachedValue, STYLE.nextCached, color);
    const nextUncached = paint(nextUncachedValue, STYLE.nextUncached, color);
    const contextUsed = paint(contextUsedValue, STYLE.context, color);
    const contextTotal = paint(contextTotalValue, STYLE.context, color);
    const cacheRead = paint(cacheReadValue, cacheReadStyle(cost.cacheReadPercent), color);
    const cacheWrite = cacheWriteValue ? paint(cacheWriteValue, cacheWriteStyle(cost.cacheWritePercent), color) : "";
    const cacheGroup = `Cache ${cacheReadValue} read${cacheWriteValue ? `, ${cacheWriteValue} write` : ""}`;
    return {
        time: paint(lastTime, STYLE.text, color),
        message_group: paint(`${lastValue} in ${lastDurationValue}`, STYLE.last, color),
        cache_group: paint(cacheGroup, cacheGroupStyle(cost), color),
        total_group: paint(`Total ${totalValue}`, STYLE.total, color),
        windows_group: paint(`Sess ${sessionValue} · 24h ${window24hValue} · 7d ${window7dValue} · 30d ${window30dValue}`, STYLE.windows, color),
        next_group: paint(`Next >= [${nextCachedValue} - ${nextUncachedValue}]`, STYLE.next, color),
        context_group: paint(`Ctx ${contextPercent(cost)} (${contextUsedValue}/${contextTotalValue})`, STYLE.context, color),
        cost: totalCost,
        msg_cost: lastCost,
        sess_cost: sessionCost,
        cost_24h: window24h,
        cost_7d: window7d,
        cost_30d: window30d,
        msg_time: lastDuration,
        cached: nextCached,
        uncached: nextUncached,
        ctx_used: contextUsed,
        ctx_total: contextTotal,
        cache_read: cacheRead,
        cache_write: cacheWrite,
    };
}

// Warns (distinct color) when the cache-read rate drops below the healthy threshold.
function cacheReadStyle(value) {
    return num(value) < 75 ? STYLE.cacheWarning : STYLE.cache;
}

// Warns when cache writes exceed the healthy threshold.
function cacheWriteStyle(value) {
    return num(value) > 20 ? STYLE.cacheWarning : STYLE.cache;
}

// Saved turn duration, else derived from its start and end timestamps.
function lastDurationMs(cost = {}) {
    const savedDurationMs = optNum(cost.lastDurationMs);
    if (savedDurationMs !== undefined) {
        return savedDurationMs;
    }

    const startedAt = optNum(cost.lastStartedAt);
    const endedAt = optNum(cost.lastEndedAt);
    if (startedAt === undefined || endedAt === undefined) {
        return undefined;
    }
    return endedAt - startedAt;
}

// Clock time of the last turn, or a placeholder before any turn completes.
function renderLastTime(cost = {}) {
    const endedAt = optNum(cost.lastEndedAt);
    return endedAt === undefined ? "--:--" : formatClock(endedAt);
}

// Warning color for the cache group when either read or write is unhealthy.
function cacheGroupStyle(cost = {}) {
    const readWarning = cacheReadStyle(cost.cacheReadPercent) === STYLE.cacheWarning;
    const writeWarning = cost.hasCacheWrite && cacheWriteStyle(cost.cacheWritePercent) === STYLE.cacheWarning;
    return readWarning || writeWarning ? STYLE.cacheWarning : STYLE.cache;
}

// Percentage of the context window used, or "?%" when sizes are unknown.
function contextPercent(cost = {}) {
    const used = optNum(cost.contextTokens);
    const limit = optNum(cost.contextTokenLimit);
    if (used === undefined || limit === undefined || limit <= 0) {
        return "?%";
    }
    return formatPercent((used / limit) * 100);
}

// Prefers the exact nano-AIU cost of the last turn, falling back to saved USD.
function lastTurnUsd(cost) {
    const lastNanoAiu = optNum(cost.lastNanoAiu);
    return lastNanoAiu !== undefined ? toUsd(lastNanoAiu) : optNum(cost.lastUsd);
}
