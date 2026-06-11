import test from "node:test";
import assert from "node:assert/strict";

import { estimateNext, officialUsageDelta, snapshotStatus, snapshotTurn, toUsd, total } from "../../src/domain/cost.mjs";

test("turn snapshots add pending cost to accepted official cost", () => {
    const patch = snapshotTurn({
        nanoAiu: 2_000_000_000,
        input: 100,
        output: 10,
        cacheRead: 60,
        pricedCacheWrite: 20,
        partial: false,
        startedAt: 10,
        endedAt: 30,
    }, { officialTotalUsd: 1, pendingUsd: 0.25 }, { currentTokens: 1000, tokenLimit: 2000 });

    assert.equal(patch.lastUsd, 0.02);
    assert.equal(patch.officialTotalUsd, 1);
    assert.equal(patch.pendingUsd, 0.27);
    assert.equal(patch.totalUsd, 1.27);
    assert.equal(patch.lastDurationMs, 20);
});

test("status snapshots clear pending after official catch-up", () => {
    const patch = snapshotStatus(
        { ai_used: { total_nano_aiu: 150_000_000_000 }, context_window: {} },
        { officialSegmentUsd: 1, pendingUsd: 0.5, totalUsd: 1.5 },
    );

    assert.equal(patch.sessionUsd, 1.5);
    assert.equal(patch.officialTotalUsd, 1.5);
    assert.equal(patch.pendingUsd, 0);
    assert.equal(patch.totalUsd, 1.5);
});

test("status snapshots promote official totals when local observed cost was incomplete", () => {
    const patch = snapshotStatus(
        { ai_used: { total_nano_aiu: 84_200_000_000 }, context_window: {} },
        { totalUsd: 0.03, pendingUsd: 0.03 },
    );

    assertNear(patch.sessionUsd, 0.842);
    assertNear(patch.officialTotalUsd, 0.842);
    assert.equal(patch.pendingUsd, 0);
    assertNear(patch.totalUsd, 0.842);
});

test("status snapshots subtract partial official catch-up from pending cost", () => {
    const patch = snapshotStatus(
        { ai_used: { total_nano_aiu: 550_000_000_000 }, context_window: {} },
        { officialSegmentUsd: 5, pendingUsd: 2, totalUsd: 7 },
    );

    assert.equal(patch.officialTotalUsd, 5.5);
    assert.equal(patch.pendingUsd, 1.5);
    assert.equal(patch.totalUsd, 7);
});

test("turn snapshots do not double-count official catch-up from the active turn", () => {
    const patch = snapshotTurn({
        nanoAiu: 90_000_000_000,
        input: 100,
        output: 10,
        cacheRead: 90,
        pricedCacheWrite: 0,
        officialStartedUsd: 0,
    }, { officialSegmentUsd: 0.9, pendingUsd: 0, totalUsd: 0.9 });

    assert.equal(patch.lastUsd, 0.9);
    assert.equal(patch.pendingUsd, 0);
    assert.equal(patch.totalUsd, 0.9);
});

test("status snapshots bank previous display total after official reset", () => {
    const patch = snapshotStatus(
        { ai_used: { total_nano_aiu: 10_000_000_000 }, context_window: {} },
        { carryUsd: 0.5, officialSegmentUsd: 2, pendingUsd: 0.25, totalUsd: 2.75 },
    );

    assert.equal(patch.carryUsd, 2.75);
    assert.equal(patch.officialSegmentUsd, 0.1);
    assert.equal(patch.officialTotalUsd, 2.85);
});

test("computes official usage deltas for rolling windows", () => {
    assert.equal(
        officialUsageDelta({ ai_used: { total_nano_aiu: 200_000_000_000 } }, { officialSegmentUsd: 1.5 }),
        0.5,
    );
    assert.equal(
        officialUsageDelta({ ai_used: { total_nano_aiu: 10_000_000_000 } }, { officialSegmentUsd: 2 }),
        0.1,
    );
    assert.equal(officialUsageDelta({}, { officialSegmentUsd: 2 }), 0);
});

test("status snapshots read context payload variants", () => {
    const direct = snapshotStatus({ context_window: { current_context_tokens: 1200, displayed_context_limit: 200000 } });
    const inferred = snapshotStatus({ context_window: { current_context_tokens: 500, current_context_used_percentage: 25 } });

    assert.equal(direct.contextTokens, 1200);
    assert.equal(direct.contextTokenLimit, 200000);
    assert.equal(inferred.contextTokenLimit, 2000);
});

test("estimates warm and cold next-turn bounds from live rates", () => {
    const estimate = estimateNext({
        contextTokens: 1000,
        inputNanoPerToken: 1000,
        cacheReadNanoPerToken: 100,
        cacheWriteNanoPerToken: 1250,
        outputNanoPerToken: 2000,
        newWorkSamples: [{ inputTokens: 10, outputTokens: 5 }],
    });

    assert.equal(estimate.lowerUsd, 0.0000016500000000000005);
    assert.equal(estimate.upperUsd, 0.0000127);
});

test("returns no estimate until context and rates are known", () => {
    assert.equal(estimateNext({ contextTokens: 1000 }), undefined);
    assert.equal(estimateNext({ inputNanoPerToken: 1000 }), undefined);
});

test("turn snapshots sample new uncached work and cap rolling history", () => {
    const priorSamples = [1, 2, 3, 4, 5].map((value) => ({ inputTokens: value, outputTokens: value }));
    const patch = snapshotTurn(
        { nanoAiu: 0, input: 100, output: 20, cacheRead: 70, pricedCacheWrite: 0 },
        { newWorkSamples: priorSamples },
    );

    assert.deepEqual(patch.newWorkSamples.map((item) => item.inputTokens), [2, 3, 4, 5, 30]);
    assert.deepEqual(patch.newWorkSamples.at(-1), { inputTokens: 30, outputTokens: 20 });
});

test("exposes display totals", () => {
    assert.equal(toUsd(1_000_000_000), 0.01);
    assert.equal(total({ totalUsd: 3, officialTotalUsd: 2 }), 3);
});

function assertNear(actual, expected) {
    assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} not near ${expected}`);
}
