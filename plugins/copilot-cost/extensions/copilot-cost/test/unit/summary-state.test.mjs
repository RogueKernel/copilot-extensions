import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
    claimUsageWindowSync,
    mergeRuntimeState,
    pruneSummarySessions,
    readRuntimeState,
    readSummaryState,
    saveUsageWindows,
    readUsageWindows,
} from "../../src/summary-state.mjs";
import { syncSessionLedgerCacheAndSummary } from "../../src/domain/windows.mjs";
import { closeFromShutdown, markOpen } from "../../src/domain/session-ledger.mjs";

test("summary windows read only the cached ledger totals", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "copilot-cost-summary-")), "summary-state.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await saveUsageWindows({ window24hUsd: 1, window7dUsd: 2, window30dUsd: 3 }, { updatedAt: now }, path);

    assert.deepEqual(await readUsageWindows(now, path), { window24hUsd: 1, window7dUsd: 2, window30dUsd: 3 });
});

test("saving ledger windows persists the cached totals", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "copilot-cost-summary-")), "summary-state.json");
    const now = Date.UTC(2026, 5, 10, 12);

    await saveUsageWindows({ window24hUsd: 5, window7dUsd: 6, window30dUsd: 7 }, { updatedAt: now }, path);
    assert.deepEqual(await readSummaryState(path), {
        version: 1,
        windows: { window24hUsd: 5, window7dUsd: 6, window30dUsd: 7, updatedAt: now },
        runtime: {},
    });
});

test("claimUsageWindowSync advances the summary timestamp only when stale", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "copilot-cost-summary-")), "summary-state.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await saveUsageWindows({ window24hUsd: 5, window7dUsd: 6, window30dUsd: 7 }, { updatedAt: now - 10 * 60 * 1000 }, path);

    assert.equal(await claimUsageWindowSync({ now, staleAfterMs: 5 * 60 * 1000, path }), true);
    assert.deepEqual((await readSummaryState(path)).windows, {
        window24hUsd: 5,
        window7dUsd: 6,
        window30dUsd: 7,
        updatedAt: now,
    });

    assert.equal(await claimUsageWindowSync({ now: now + 60 * 1000, staleAfterMs: 5 * 60 * 1000, path }), false);
    assert.equal((await readSummaryState(path)).windows.updatedAt, now);
});

test("claimUsageWindowSync lets only one concurrent caller claim a stale window", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "copilot-cost-summary-")), "summary-state.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await saveUsageWindows({ window24hUsd: 1, window7dUsd: 2, window30dUsd: 3 }, { updatedAt: now - 10 * 60 * 1000 }, path);

    const claims = await Promise.all([
        claimUsageWindowSync({ now, staleAfterMs: 5 * 60 * 1000, path }),
        claimUsageWindowSync({ now, staleAfterMs: 5 * 60 * 1000, path }),
    ]);

    assert.deepEqual(claims.sort(), [false, true]);
    assert.equal((await readSummaryState(path)).windows.updatedAt, now);
});

test("pruning summary sessions removes only closed session runtime records", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "copilot-cost-summary-")), "summary-state.json");

    await mergeRuntimeState("/tmp/session-state/closed", { sessionId: "closed", totalUsd: 1 }, path);
    await mergeRuntimeState("/tmp/session-state/open", { sessionId: "open", totalUsd: 2 }, path);

    await pruneSummarySessions(["closed"], path);

    assert.equal(await readRuntimeState("/tmp/session-state/closed", path), undefined);
    assert.equal((await readRuntimeState("/tmp/session-state/open", path)).totalUsd, 2);
});

test("full ledger sync refreshes summary windows and prunes closed runtime state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "copilot-cost-summary-"));
    const ledgerPath = join(dir, "session-ledger.json");
    const summaryPath = join(dir, "summary-state.json");
    const now = Date.UTC(2026, 5, 10, 12);

    await mergeRuntimeState("/tmp/session-state/closed", { sessionId: "closed", totalUsd: 9 }, summaryPath);

    await syncSessionLedgerCacheAndSummary((ledger) => closeFromShutdown(
        markOpen(ledger, "closed", now - 1_000),
        { id: "closed", totalNanoAiu: 2_000_000_000, at: now - 500 },
    ), ledgerPath, now, summaryPath);

    const state = await readSummaryState(summaryPath);
    assert.deepEqual(state.runtime, {});
    assert.deepEqual(state.windows, {
        window24hUsd: 0.02,
        window7dUsd: 0.02,
        window30dUsd: 0.02,
        updatedAt: now,
    });
});
