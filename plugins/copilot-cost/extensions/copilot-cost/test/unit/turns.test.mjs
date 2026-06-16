import test from "node:test";
import assert from "node:assert/strict";

import { estimateNext, snapshotTurn } from "../../src/domain/cost.mjs";
import { collect, createTurn } from "../../src/domain/turns.mjs";

test("collects charged cache-write usage without marking the turn partial", () => {
    const turn = createTurn();

    collect(turn, usageEvent({
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 20,
        cacheWriteTokens: 30,
        totalNanoAiu: 2_000_000_000,
        tokenDetails: [
            detail("input", 50, 1_000_000, 1000),
            detail("cache_read", 20, 100_000, 1000),
            detail("cache_creation_input_tokens", 30, 1_250_000, 1000),
            detail("output", 10, 3_000_000, 1000),
        ],
    }));

    assert.equal(turn.pricedCacheWrite, 30);
    assert.equal(turn.cacheWriteNanoPerToken, 1250);
    assert.equal(turn.partial, false);

    const state = snapshotTurn(turn, {}, { currentTokens: 1000 });
    const next = estimateNext(state);
    assert.ok(Math.abs(next.upperUsd - 0.000013675) < 1e-12);
});

test("collects unpriced cache writes as partial usage", () => {
    const turn = createTurn();

    collect(turn, usageEvent({
        inputTokens: 100,
        outputTokens: 10,
        cacheWriteTokens: 30,
        totalNanoAiu: 1_000_000_000,
        tokenDetails: [
            detail("input", 70, 1_000_000, 1000),
            detail("cache_write", 30, 0, 1000),
            detail("output", 10, 3_000_000, 1000),
        ],
    }));

    assert.equal(turn.pricedCacheWrite, 0);
    assert.equal(turn.partial, true);
});

test("uses the latest model's token rates when usage events change models", () => {
    const turn = createTurn();

    collect(turn, usageEvent({
        inputTokens: 10,
        outputTokens: 1,
        totalNanoAiu: 100_000_000,
        tokenDetails: [
            detail("input", 10, 500_000, 1000),
            detail("cache_read", 5, 50_000, 1000),
            detail("output", 1, 1_000_000, 1000),
        ],
    }));
    collect(turn, usageEvent({
        model: "new-model",
        inputTokens: 10,
        outputTokens: 1,
        cacheReadTokens: 5,
        totalNanoAiu: 200_000_000,
        tokenDetails: [
            detail("input", 10, 900_000, 1000),
            detail("cache_read", 5, 90_000, 1000),
            detail("output", 1, 2_000_000, 1000),
        ],
    }));

    const state = snapshotTurn(turn, {}, { currentTokens: 1000 });
    assert.equal(state.inputNanoPerToken, 900);
    assert.equal(state.cacheReadNanoPerToken, 90);
    assert.equal(state.outputNanoPerToken, 2000);
    assert.ok(Math.abs(estimateNext(state).lowerUsd - 0.00000148) < 1e-12);
});

function usageEvent({
    model = "model",
    inputTokens = 0,
    outputTokens = 0,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    totalNanoAiu,
    tokenDetails = [],
} = {}) {
    return {
        timestamp: "2026-01-01T00:00:00.000Z",
        data: {
            model,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            copilotUsage: { totalNanoAiu, tokenDetails },
        },
    };
}

function detail(tokenType, tokenCount, costPerBatch, batchSize) {
    return { tokenType, tokenCount, costPerBatch, batchSize };
}
