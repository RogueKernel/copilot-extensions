// Token-detail classification and live rate measurement.
// Provider payloads use loose token-detail names; this module keeps those naming
// quirks behind predicates so accounting code can ask domain questions.

import { num, ratio } from "../math.mjs";

// Counts priced cache-write tokens from detailed usage rows.
export function countCacheWrites(usage) {
    let tokens = 0;
    for (const detail of tokenDetails(usage)) {
        if (isCacheWriteToken(detail)) {
            tokens += num(detail.tokenCount);
        }
    }
    return tokens;
}

// Measures the highest nano-AIU/token rate for matching token details.
export function measureRate(usage, predicate) {
    let highest;
    for (const detail of tokenDetails(usage)) {
        if (!predicate(detail)) {
            continue;
        }

        const rate = ratePerToken(detail);
        if (rate !== undefined) {
            highest = highest === undefined ? rate : Math.max(highest, rate);
        }
    }
    return highest;
}

// Matches regular input-token detail rows.
export function isInputToken(detail) {
    return tokenType(detail) === "input";
}

// Matches regular output-token detail rows.
export function isOutputToken(detail) {
    return tokenType(detail) === "output";
}

// Matches cache-read token detail rows.
export function isCacheReadToken(detail) {
    const type = tokenType(detail);
    return type.includes("cache") && type.includes("read");
}

// Matches priced cache-write token detail rows.
export function isCacheWriteToken(detail) {
    const type = tokenType(detail);
    return type.includes("cache") && /\b(write|create|creation)\b/.test(type) && num(detail.costPerBatch) > 0;
}

function tokenDetails(usage) {
    const details = usage.copilotUsage?.tokenDetails;
    return Array.isArray(details) ? details : [];
}

function ratePerToken(detail) {
    return ratio(num(detail.costPerBatch), num(detail.batchSize));
}

function tokenType(detail) {
    return String(detail?.tokenType ?? "").toLowerCase().replace(/[_-]/g, " ");
}
