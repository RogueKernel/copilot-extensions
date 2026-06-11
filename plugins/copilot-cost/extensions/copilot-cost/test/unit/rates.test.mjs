import test from "node:test";
import assert from "node:assert/strict";

import {
    countCacheWrites,
    isCacheReadToken,
    isCacheWriteToken,
    isInputToken,
    isOutputToken,
    measureRate,
} from "../../src/domain/rates.mjs";

test("classifies provider token-detail names", () => {
    assert.equal(isInputToken({ tokenType: "input" }), true);
    assert.equal(isOutputToken({ tokenType: "output" }), true);
    assert.equal(isCacheReadToken({ tokenType: "cache_read" }), true);
    assert.equal(isCacheReadToken({ tokenType: "cache-read" }), true);
    assert.equal(isCacheWriteToken({ tokenType: "cache_creation_input_tokens", costPerBatch: 100 }), true);
    assert.equal(isCacheWriteToken({ tokenType: "cache-write", costPerBatch: 100 }), true);
});

test("ignores unpriced cache-write token details", () => {
    assert.equal(isCacheWriteToken({ tokenType: "cache_write", costPerBatch: 0 }), false);
    assert.equal(isCacheWriteToken({ tokenType: "cache_write" }), false);
});

test("counts only priced cache-write tokens", () => {
    const usage = usageWithDetails([
        detail("cache_write", 10, 0, 1000),
        detail("cache_creation_input_tokens", 20, 1_000_000, 1000),
        detail("input", 30, 2_000_000, 1000),
    ]);

    assert.equal(countCacheWrites(usage), 20);
});

test("measureRate selects the highest matching finite rate", () => {
    const usage = usageWithDetails([
        detail("input", 100, 500_000, 1000),
        detail("input", 100, 900_000, 1000),
        detail("output", 10, 2_000_000, 1000),
    ]);

    assert.equal(measureRate(usage, isInputToken), 900);
    assert.equal(measureRate(usage, isOutputToken), 2000);
});

test("measureRate ignores missing and malformed token details", () => {
    assert.equal(measureRate({}, isInputToken), undefined);
    assert.equal(measureRate(usageWithDetails([{ tokenType: "input", costPerBatch: 1, batchSize: 0 }]), isInputToken), undefined);
    assert.equal(countCacheWrites({}), 0);
});

function usageWithDetails(tokenDetails) {
    return { copilotUsage: { tokenDetails } };
}

function detail(tokenType, tokenCount, costPerBatch, batchSize) {
    return { tokenType, tokenCount, costPerBatch, batchSize };
}
