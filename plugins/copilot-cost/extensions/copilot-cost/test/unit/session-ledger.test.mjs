import test from "node:test";
import assert from "node:assert/strict";

import {
    closeFromShutdown,
    autoCloseStaleSessions,
    ledgerUsageEvents,
    markOpen,
    mergeLiveStatusline,
    mergeSession,
    nanoAiuToUsd,
    sessionLedgerWindows,
    SOURCE_ESTIMATED_TOKENS,
    SOURCE_STATUSLINE,
    SOURCE_SHUTDOWN,
    STATE_AUTO_CLOSED,
    STATE_CLOSED,
    STATE_OPEN,
} from "../../src/domain/session-ledger.mjs";

const day = 24 * 60 * 60 * 1000;

test("live statusline marks sessions open and keeps last updated when cost changes", () => {
    let ledger = mergeLiveStatusline({}, { id: "abc", totalNanoAiu: 1_000_000_000, at: 100 });
    ledger = mergeLiveStatusline(ledger, { id: "abc", totalNanoAiu: 1_000_000_000, at: 200 });

    assert.equal(ledger.sessions.abc.state, STATE_OPEN);
    assert.equal(ledger.sessions.abc.totalNanoAiu, 1_000_000_000);
    assert.equal(ledger.sessions.abc.source, SOURCE_STATUSLINE);
    assert.equal(ledger.sessions.abc.lastSeenAt, 200);
    assert.equal(ledger.sessions.abc.lastUpdatedAt, 100);

    ledger = mergeLiveStatusline(ledger, { id: "abc", totalNanoAiu: 2_000_000_000, at: 300 });
    assert.equal(ledger.sessions.abc.totalNanoAiu, 2_000_000_000);
    assert.equal(ledger.sessions.abc.lastUpdatedAt, 300);
});

test("shutdown totals close sessions and beat stale statusline values", () => {
    let ledger = mergeLiveStatusline({}, { id: "abc", totalNanoAiu: 1_000_000_000, at: 100 });
    ledger = closeFromShutdown(ledger, { id: "abc", totalNanoAiu: 3_000_000_000, at: 200 });
    ledger = mergeLiveStatusline(ledger, { id: "abc", totalNanoAiu: 2_000_000_000, at: 300 });

    assert.equal(ledger.sessions.abc.state, STATE_CLOSED);
    assert.equal(ledger.sessions.abc.source, SOURCE_SHUTDOWN);
    assert.equal(ledger.sessions.abc.totalNanoAiu, 3_000_000_000);
    assert.equal(ledger.sessions.abc.closedAt, 200);
});

test("auto-closing stale open sessions preserves existing live total", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const ledger = autoCloseStaleSessions(markOpen({
        sessions: {
            stale: {
                id: "stale",
                state: STATE_OPEN,
                totalNanoAiu: 5_000_000_000,
                source: SOURCE_STATUSLINE,
                lastSeenAt: now - 8 * day,
                lastUpdatedAt: 50,
            },
        },
    }, "current", now), now);

    assert.equal(ledger.sessions.stale.state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions.stale.totalNanoAiu, 5_000_000_000);
    assert.equal(ledger.sessions.stale.source, SOURCE_STATUSLINE);
    assert.equal(ledger.sessions.stale.lastUpdatedAt, 50);
    assert.equal(ledger.sessions.current.state, STATE_OPEN);
});

test("auto-closing stale sessions estimates from token profiles only when no total exists", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const ledger = autoCloseStaleSessions({
        sessions: {
            exact: {
                id: "exact",
                state: STATE_CLOSED,
                source: SOURCE_SHUTDOWN,
                totalNanoAiu: 1_000_000_000,
                lastSeenAt: now - day,
                modelMetrics: {
                    "gpt-test": {
                        totalNanoAiu: 1_000_000_000,
                        tokenTotals: { outputTokens: 100 },
                    },
                },
            },
            stale: {
                id: "stale",
                state: STATE_OPEN,
                source: "none",
                lastSeenAt: now - 8 * day,
                modelMetrics: {
                    "gpt-test": {
                        tokenTotals: { outputTokens: 50 },
                    },
                },
            },
        },
    }, now);

    assert.equal(ledger.sessions.stale.state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions.stale.source, SOURCE_ESTIMATED_TOKENS);
    assert.equal(ledger.sessions.stale.estimateConfidence, "low");
    assert.equal(ledger.sessions.stale.totalNanoAiu, 500_000_000);
});

test("auto-closing pre-usage-based sessions estimates cost from retained tokens", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const ledger = autoCloseStaleSessions({
        sessions: {
            exact: {
                id: "exact",
                state: STATE_CLOSED,
                source: SOURCE_SHUTDOWN,
                totalNanoAiu: 1_000_000_000,
                lastSeenAt: now - day,
                modelMetrics: {
                    "gpt-test": {
                        totalNanoAiu: 1_000_000_000,
                        tokenTotals: { outputTokens: 100 },
                    },
                },
            },
            stale: {
                id: "stale",
                state: STATE_OPEN,
                source: "none",
                lastSeenAt: Date.UTC(2026, 4, 31, 12),
                modelMetrics: {
                    "gpt-test": {
                        tokenTotals: { outputTokens: 50 },
                    },
                },
            },
        },
    }, now);

    assert.equal(ledger.sessions.stale.state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions.stale.source, SOURCE_ESTIMATED_TOKENS);
    assert.equal(ledger.sessions.stale.totalNanoAiu, 500_000_000);
    assert.equal(ledger.sessions.stale.estimateConfidence, "low");
});

test("ledger windows derive from session bucket timestamps", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const ledger = {
        sessions: {
            today: {
                id: "today",
                state: STATE_CLOSED,
                source: SOURCE_SHUTDOWN,
                totalNanoAiu: 1_000_000_000,
                closedAt: now - 1,
                modelMetrics: {
                    "gpt-test": {
                        totalNanoAiu: 1_000_000_000,
                        tokenTotals: { outputTokens: 100 },
                    },
                },
            },
            week: { id: "week", state: STATE_AUTO_CLOSED, totalNanoAiu: 2_000_000_000, lastSeenAt: now - 2 * day },
            month: { id: "month", state: STATE_CLOSED, totalNanoAiu: 3_000_000_000, closedAt: now - 8 * day },
            preCredit: {
                id: "preCredit",
                state: STATE_CLOSED,
                source: SOURCE_SHUTDOWN,
                totalNanoAiu: 50_000_000_000,
                closedAt: Date.UTC(2026, 4, 31, 23, 59),
                modelMetrics: {
                    "gpt-test": {
                        totalNanoAiu: 50_000_000_000,
                        tokenTotals: { outputTokens: 50 },
                    },
                },
            },
            history: {
                id: "history",
                state: STATE_CLOSED,
                source: SOURCE_SHUTDOWN,
                totalNanoAiu: 4_000_000_000,
                closedAt: now - 179 * day,
                modelMetrics: {
                    "gpt-test": {
                        totalNanoAiu: 4_000_000_000,
                        tokenTotals: { outputTokens: 25 },
                    },
                },
            },
            old: { id: "old", state: STATE_CLOSED, totalNanoAiu: 6_000_000_000, closedAt: now - 181 * day },
        },
    };

    const windows = sessionLedgerWindows(ledger, now);
    assert.deepEqual({
        window24hUsd: Number(windows.window24hUsd.toFixed(6)),
        window7dUsd: Number(windows.window7dUsd.toFixed(6)),
        window30dUsd: Number(windows.window30dUsd.toFixed(6)),
    }, {
        window24hUsd: 0.01,
        window7dUsd: 0.03,
        window30dUsd: 0.065,
    });
    assert.deepEqual(ledgerUsageEvents(ledger, now).map((event) => event.id), ["today", "week", "month", "preCredit", "history"]);
    assert.deepEqual(
        ledgerUsageEvents(ledger, now, { includePreCredit: true }).map((event) => event.id),
        ["today", "week", "month", "preCredit", "history"],
    );
    assert.equal(nanoAiuToUsd(1_000_000_000), 0.01);
});

test("mergeSession discovers null sessions without inventing a state", () => {
    const ledger = mergeSession({}, { id: "new-session", firstSeenAt: 10, lastSeenAt: 20 }, 30);

    assert.equal(ledger.sessions["new-session"].state, null);
    assert.equal(ledger.sessions["new-session"].source, "none");
    assert.equal(ledger.sessions["new-session"].lastUpdatedAt, undefined);
});
