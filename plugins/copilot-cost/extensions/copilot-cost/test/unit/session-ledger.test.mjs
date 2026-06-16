import test from "node:test";
import assert from "node:assert/strict";

import {
    closeFromShutdown,
    autoCloseStaleSessions,
    ledgerUsageEvents,
    markOpen,
    mergeSession,
    nanoAiuToUsd,
    normalizeLedger,
    pruneLedger,
    sessionLedgerWindows,
    SOURCE_COMPACTION,
    SOURCE_ESTIMATED_TOKENS,
    SOURCE_RUNTIME,
    SOURCE_STATUSLINE,
    SOURCE_SHUTDOWN,
    SOURCE_USAGE_EVENTS,
    STATE_AUTO_CLOSED,
    STATE_CLOSED,
    STATE_OPEN,
    SURFACE_CLI,
    SURFACE_VSCODE,
} from "../../src/domain/session-ledger.mjs";

const day = 24 * 60 * 60 * 1000;

function estimateSingleStaleModelSession(model, tokenTotals, now = Date.UTC(2026, 5, 10, 12)) {
    const ledger = autoCloseStaleSessions({
        sessions: {
            stale: {
                id: "stale",
                state: STATE_OPEN,
                source: "none",
                lastSeenAt: now - 8 * day,
                modelMetrics: {
                    [model]: { tokenTotals },
                },
            },
        },
    }, now);
    return ledger.sessions.stale;
}

test("normalizing the ledger backfills session surfaces from ids", () => {
    const ledger = normalizeLedger({
        sessions: {
            "cli-session": { id: "cli-session", state: STATE_OPEN, source: "none" },
            "vscode:root:workspace:session": { id: "vscode:root:workspace:session", state: STATE_OPEN, source: "none" },
        },
    });

    assert.equal(ledger.sessions["cli-session"].surface, SURFACE_CLI);
    assert.equal(ledger.sessions["vscode:root:workspace:session"].surface, SURFACE_VSCODE);
});

test("shutdown totals close sessions and beat legacy statusline ledger values", () => {
    let ledger = mergeSession({}, {
        id: "abc",
        state: STATE_OPEN,
        surface: SURFACE_CLI,
        totalNanoAiu: 1_000_000_000,
        source: SOURCE_STATUSLINE,
        firstSeenAt: 100,
        lastSeenAt: 100,
    }, 100);
    ledger = closeFromShutdown(ledger, { id: "abc", totalNanoAiu: 3_000_000_000, at: 200 });
    ledger = mergeSession(ledger, {
        id: "abc",
        state: STATE_OPEN,
        surface: SURFACE_CLI,
        totalNanoAiu: 2_000_000_000,
        source: SOURCE_STATUSLINE,
        lastSeenAt: 300,
    }, 300);

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

test("auto-closing stale open sessions preserves runtime totals", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const ledger = autoCloseStaleSessions(markOpen({
        sessions: {
            stale: {
                id: "stale",
                state: STATE_OPEN,
                totalNanoAiu: 7_000_000_000,
                source: SOURCE_RUNTIME,
                lastSeenAt: now - 8 * day,
                lastUpdatedAt: 60,
            },
        },
    }, "current", now), now);

    assert.equal(ledger.sessions.stale.state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions.stale.totalNanoAiu, 7_000_000_000);
    assert.equal(ledger.sessions.stale.source, SOURCE_RUNTIME);
    assert.equal(ledger.sessions.stale.lastUpdatedAt, 60);
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

test("auto-closing stale partial sessions adds token estimates to observed compaction cost", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const ledger = autoCloseStaleSessions({
        sessions: {
            pricedProfile: {
                id: "pricedProfile",
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
            partial: {
                id: "partial",
                state: STATE_OPEN,
                source: SOURCE_COMPACTION,
                totalNanoAiu: 200_000_000,
                compactionNanoAiu: 200_000_000,
                lastSeenAt: now - 8 * day,
                modelMetrics: {
                    "gpt-test": {
                        tokenTotals: { outputTokens: 50 },
                    },
                },
            },
        },
    }, now);

    assert.equal(ledger.sessions.partial.state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions.partial.source, SOURCE_ESTIMATED_TOKENS);
    assert.equal(ledger.sessions.partial.totalNanoAiu, 700_000_000);
    assert.equal(ledger.sessions.partial.estimateConfidence, "low");
});

test("auto-closing stale sessions estimates token classes with separate model rates", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const ledger = autoCloseStaleSessions({
        sessions: {
            inputProfile: {
                id: "inputProfile",
                state: STATE_CLOSED,
                source: SOURCE_SHUTDOWN,
                totalNanoAiu: 1_000,
                lastSeenAt: now - day,
                modelMetrics: {
                    "gpt-test": {
                        totalNanoAiu: 1_000,
                        tokenTotals: { inputTokens: 100 },
                    },
                },
            },
            outputProfile: {
                id: "outputProfile",
                state: STATE_CLOSED,
                source: SOURCE_SHUTDOWN,
                totalNanoAiu: 10_000,
                lastSeenAt: now - day,
                modelMetrics: {
                    "gpt-test": {
                        totalNanoAiu: 10_000,
                        tokenTotals: { outputTokens: 100 },
                    },
                },
            },
            staleInput: {
                id: "staleInput",
                state: STATE_OPEN,
                source: "none",
                lastSeenAt: now - 8 * day,
                modelMetrics: {
                    "gpt-test": {
                        tokenTotals: { inputTokens: 50 },
                    },
                },
            },
            staleOutput: {
                id: "staleOutput",
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

    assert.equal(ledger.sessions.staleInput.state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions.staleInput.totalNanoAiu, 500);
    assert.equal(ledger.sessions.staleOutput.state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions.staleOutput.totalNanoAiu, 5_000);
});

test("auto-closing stale sessions estimates cached input and cache writes with separate rates", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const ledger = autoCloseStaleSessions({
        sessions: {
            cacheReadProfile: {
                id: "cacheReadProfile",
                state: STATE_CLOSED,
                source: SOURCE_SHUTDOWN,
                totalNanoAiu: 100,
                lastSeenAt: now - day,
                modelMetrics: {
                    "claude-test": {
                        totalNanoAiu: 100,
                        tokenTotals: { cacheReadTokens: 100 },
                    },
                },
            },
            cacheWriteProfile: {
                id: "cacheWriteProfile",
                state: STATE_CLOSED,
                source: SOURCE_SHUTDOWN,
                totalNanoAiu: 1_250,
                lastSeenAt: now - day,
                modelMetrics: {
                    "claude-test": {
                        totalNanoAiu: 1_250,
                        tokenTotals: { cacheWriteTokens: 100 },
                    },
                },
            },
            staleCacheRead: {
                id: "staleCacheRead",
                state: STATE_OPEN,
                source: "none",
                lastSeenAt: now - 8 * day,
                modelMetrics: {
                    "claude-test": {
                        tokenTotals: { cacheReadTokens: 50 },
                    },
                },
            },
            staleCacheWrite: {
                id: "staleCacheWrite",
                state: STATE_OPEN,
                source: "none",
                lastSeenAt: now - 8 * day,
                modelMetrics: {
                    "claude-test": {
                        tokenTotals: { cacheWriteTokens: 40 },
                    },
                },
            },
        },
    }, now);

    assert.equal(ledger.sessions.staleCacheRead.state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions.staleCacheRead.totalNanoAiu, 50);
    assert.equal(ledger.sessions.staleCacheWrite.state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions.staleCacheWrite.totalNanoAiu, 500);
});

test("auto-closing stale sessions can estimate from post-pricing usage-event AIU model profiles", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const ledger = autoCloseStaleSessions({
        sessions: {
            observed: {
                id: "observed",
                state: STATE_OPEN,
                source: SOURCE_USAGE_EVENTS,
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

test("auto-closing stale sessions without AIU or usable model rates keeps them unpriced", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const ledger = autoCloseStaleSessions({
        sessions: {
            noUsage: {
                id: "noUsage",
                state: STATE_OPEN,
                source: "none",
                lastSeenAt: now - 8 * day,
            },
            unknownModel: {
                id: "unknownModel",
                state: STATE_OPEN,
                source: "none",
                lastSeenAt: now - 8 * day,
                modelMetrics: {
                    "unknown-model": {
                        tokenTotals: { outputTokens: 50 },
                    },
                },
            },
        },
    }, now);

    assert.equal(ledger.sessions.noUsage.state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions.noUsage.source, "none");
    assert.equal(ledger.sessions.noUsage.totalNanoAiu, undefined);
    assert.equal(ledger.sessions.noUsage.estimateConfidence, undefined);
    assert.equal(ledger.sessions.unknownModel.state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions.unknownModel.source, "none");
    assert.equal(ledger.sessions.unknownModel.totalNanoAiu, undefined);
    assert.equal(ledger.sessions.unknownModel.estimateConfidence, undefined);
});

test("auto-closing stale sessions estimates known models from GitHub pricing fallback", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const ledger = autoCloseStaleSessions({
        sessions: {
            stale: {
                id: "stale",
                state: STATE_OPEN,
                source: "none",
                lastSeenAt: now - 8 * day,
                modelMetrics: {
                    "Claude Sonnet 4.6": {
                        tokenTotals: {
                            inputTokens: 100,
                            cacheReadTokens: 50,
                            cacheWriteTokens: 10,
                            outputTokens: 20,
                        },
                    },
                },
            },
        },
    }, now);

    assert.equal(ledger.sessions.stale.state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions.stale.source, SOURCE_ESTIMATED_TOKENS);
    assert.equal(ledger.sessions.stale.totalNanoAiu, 47_250_000);
    assert.equal(ledger.sessions.stale.estimateModel, "Claude Sonnet 4.6");
});

test("auto-closing stale sessions treats cached tokens as part of total input for GitHub pricing fallback", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const ledger = autoCloseStaleSessions({
        sessions: {
            stale: {
                id: "stale",
                state: STATE_OPEN,
                source: "none",
                lastSeenAt: now - 8 * day,
                modelMetrics: {
                    "gpt-5-mini": {
                        tokenTotals: {
                            inputTokens: 1000,
                            cacheReadTokens: 900,
                            outputTokens: 10,
                        },
                    },
                },
            },
        },
    }, now);

    assert.equal(ledger.sessions.stale.state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions.stale.source, SOURCE_ESTIMATED_TOKENS);
    assert.equal(ledger.sessions.stale.totalNanoAiu, 6_750_000);
});

test("auto-closing stale sessions does not apply long-context pricing to aggregate session tokens", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const ledger = autoCloseStaleSessions({
        sessions: {
            stale: {
                id: "stale",
                state: STATE_OPEN,
                source: "none",
                lastSeenAt: now - 8 * day,
                modelMetrics: {
                    "gpt-5.5": {
                        tokenTotals: {
                            inputTokens: 300_000,
                            cacheReadTokens: 290_000,
                            outputTokens: 1000,
                        },
                    },
                },
            },
        },
    }, now);

    assert.equal(ledger.sessions.stale.state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions.stale.source, SOURCE_ESTIMATED_TOKENS);
    assert.equal(ledger.sessions.stale.totalNanoAiu, 22_500_000_000);
});

test("auto-closing stale sessions prefers observed local rates over GitHub pricing fallback", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const ledger = autoCloseStaleSessions({
        sessions: {
            observed: {
                id: "observed",
                state: STATE_CLOSED,
                source: SOURCE_SHUTDOWN,
                totalNanoAiu: 1_000,
                closedAt: now - day,
                modelMetrics: {
                    "Claude Sonnet 4.6": {
                        totalNanoAiu: 1_000,
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
                    "Claude Sonnet 4.6": {
                        tokenTotals: { outputTokens: 50 },
                    },
                },
            },
        },
    }, now);

    assert.equal(ledger.sessions.stale.state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions.stale.source, SOURCE_ESTIMATED_TOKENS);
    assert.equal(ledger.sessions.stale.totalNanoAiu, 500);
});

test("auto-closing stale sessions estimates known models and ignores unknown models in the same session", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const ledger = autoCloseStaleSessions({
        sessions: {
            mixed: {
                id: "mixed",
                state: STATE_OPEN,
                source: "none",
                lastSeenAt: now - 8 * day,
                modelMetrics: {
                    "gpt-5-mini": {
                        tokenTotals: { inputTokens: 100 },
                    },
                    "unknown-model": {
                        tokenTotals: { outputTokens: 100_000 },
                    },
                },
            },
        },
    }, now);

    assert.equal(ledger.sessions.mixed.state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions.mixed.source, SOURCE_ESTIMATED_TOKENS);
    assert.equal(ledger.sessions.mixed.totalNanoAiu, 2_500_000);
    assert.equal(ledger.sessions.mixed.estimateModel, "gpt-5-mini");
});

test("auto-closing stale sessions normalizes GitHub pricing model aliases", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const ledger = autoCloseStaleSessions({
        sessions: {
            stale: {
                id: "stale",
                state: STATE_OPEN,
                source: "none",
                lastSeenAt: now - 8 * day,
                modelMetrics: {
                    "claude-opus-4-6": {
                        tokenTotals: { outputTokens: 10 },
                    },
                },
            },
        },
    }, now);

    assert.equal(ledger.sessions.stale.state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions.stale.source, SOURCE_ESTIMATED_TOKENS);
    assert.equal(ledger.sessions.stale.totalNanoAiu, 25_000_000);
    assert.equal(ledger.sessions.stale.estimateModel, "claude-opus-4-6");
});

test("auto-closing stale sessions prices all published GitHub model families from token totals", () => {
    const standardTokens = { inputTokens: 1000, cacheReadTokens: 600, outputTokens: 100 };
    const anthropicTokens = { inputTokens: 1000, cacheReadTokens: 600, cacheWriteTokens: 100, outputTokens: 50 };
    const aggregateTieredTokens = { inputTokens: 300_000, cacheReadTokens: 290_000, outputTokens: 1000 };

    const cases = [
        { model: "GPT-5 mini", tokens: standardTokens, expectedNanoAiu: 31_500_000 },
        { model: "GPT-5.3-Codex", tokens: standardTokens, expectedNanoAiu: 220_500_000 },
        { model: "GPT-5.4", tokens: aggregateTieredTokens, expectedNanoAiu: 11_250_000_000 },
        { model: "GPT-5.4 mini", tokens: standardTokens, expectedNanoAiu: 79_500_000 },
        { model: "GPT-5.4 nano", tokens: standardTokens, expectedNanoAiu: 21_700_000 },
        { model: "GPT-5.5", tokens: aggregateTieredTokens, expectedNanoAiu: 22_500_000_000 },
        { model: "Claude Haiku 4.5", tokens: anthropicTokens, expectedNanoAiu: 73_500_000 },
        { model: "Claude Sonnet 4", tokens: anthropicTokens, expectedNanoAiu: 220_500_000 },
        { model: "Claude Sonnet 4.5", tokens: anthropicTokens, expectedNanoAiu: 220_500_000 },
        { model: "Claude Sonnet 4.6", tokens: anthropicTokens, expectedNanoAiu: 220_500_000 },
        { model: "Claude Opus 4.5", tokens: anthropicTokens, expectedNanoAiu: 367_500_000 },
        { model: "Claude Opus 4.6", tokens: anthropicTokens, expectedNanoAiu: 367_500_000 },
        { model: "Claude Opus 4.7", tokens: anthropicTokens, expectedNanoAiu: 367_500_000 },
        { model: "Claude Opus 4.8", tokens: anthropicTokens, expectedNanoAiu: 367_500_000 },
        { model: "Claude Fable 5", tokens: anthropicTokens, expectedNanoAiu: 735_000_000 },
        { model: "Gemini 2.5 Pro", tokens: standardTokens, expectedNanoAiu: 157_500_000 },
        { model: "Gemini 3 Flash", tokens: standardTokens, expectedNanoAiu: 53_000_000 },
        { model: "Gemini 3.1 Pro", tokens: aggregateTieredTokens, expectedNanoAiu: 9_000_000_000 },
        { model: "Gemini 3.5 Flash", tokens: standardTokens, expectedNanoAiu: 159_000_000 },
        { model: "Raptor mini", tokens: standardTokens, expectedNanoAiu: 31_500_000 },
        { model: "MAI-Code-1-Flash", tokens: standardTokens, expectedNanoAiu: 79_500_000 },
    ];

    for (const { model, tokens, expectedNanoAiu } of cases) {
        const session = estimateSingleStaleModelSession(model, tokens);
        assert.equal(session.state, STATE_AUTO_CLOSED, model);
        assert.equal(session.source, SOURCE_ESTIMATED_TOKENS, model);
        assert.equal(session.totalNanoAiu, expectedNanoAiu, model);
        assert.equal(session.estimateModel, model, model);
    }
});

test("auto-closing stale sessions clamps uncached input when cache totals exceed total input", () => {
    const session = estimateSingleStaleModelSession("GPT-5 mini", {
        inputTokens: 100,
        cacheReadTokens: 120,
        outputTokens: 10,
    });

    assert.equal(session.state, STATE_AUTO_CLOSED);
    assert.equal(session.source, SOURCE_ESTIMATED_TOKENS);
    assert.equal(session.totalNanoAiu, 2_300_000);
});

test("ledger usage events exclude unpriced open token-only sessions", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const ledger = {
        sessions: {
            recentTokenOnly: {
                id: "recentTokenOnly",
                state: STATE_OPEN,
                source: "none",
                lastSeenAt: now - day,
                modelMetrics: {
                    "gpt-test": {
                        tokenTotals: { outputTokens: 30 },
                    },
                },
            },
            recentPriced: {
                id: "recentPriced",
                state: STATE_OPEN,
                source: SOURCE_USAGE_EVENTS,
                totalNanoAiu: 1_000_000_000,
                lastSeenAt: now - day,
                modelMetrics: {
                    "gpt-test": {
                        totalNanoAiu: 1_000_000_000,
                        tokenTotals: { outputTokens: 100 },
                    },
                },
            },
            staleEstimate: {
                id: "staleEstimate",
                state: STATE_AUTO_CLOSED,
                source: SOURCE_ESTIMATED_TOKENS,
                totalNanoAiu: 500_000_000,
                lastSeenAt: now - 8 * day,
                estimateConfidence: "low",
            },
            closed: {
                id: "closed",
                state: STATE_CLOSED,
                source: SOURCE_SHUTDOWN,
                totalNanoAiu: 2_000_000_000,
                closedAt: now - 2 * day,
            },
        },
    };

    assert.deepEqual(ledgerUsageEvents(ledger, now).map((event) => event.id), [
        "recentPriced",
        "staleEstimate",
        "closed",
    ]);
});

test("ledger usage events refresh stored token estimates from retained model tokens", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const ledger = {
        sessions: {
            staleEstimate: {
                id: "staleEstimate",
                state: STATE_AUTO_CLOSED,
                source: SOURCE_ESTIMATED_TOKENS,
                totalNanoAiu: 29_250_000,
                lastSeenAt: Date.UTC(2026, 5, 2, 12),
                estimateConfidence: "low",
                modelMetrics: {
                    "gpt-5-mini": {
                        tokenTotals: {
                            inputTokens: 1000,
                            cacheReadTokens: 900,
                            outputTokens: 10,
                        },
                    },
                },
            },
        },
    };

    assert.deepEqual(ledgerUsageEvents(ledger, now), [
        { id: "staleEstimate", at: Date.UTC(2026, 5, 2, 12), usd: nanoAiuToUsd(6_750_000) },
    ]);
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

test("ledger usage events fall back to model metrics when shutdown total is zero", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const ledger = {
        sessions: {
            modelOnly: {
                id: "modelOnly",
                state: STATE_CLOSED,
                source: SOURCE_SHUTDOWN,
                totalNanoAiu: 0,
                closedAt: now - day,
                modelMetrics: {
                    "gpt-test": {
                        totalNanoAiu: 2_000_000_000,
                        tokenTotals: { outputTokens: 100 },
                    },
                },
            },
        },
    };

    assert.deepEqual(ledgerUsageEvents(ledger, now), [
        { at: now - day, usd: 0.02, id: "modelOnly" },
    ]);
});

test("ledger windows count concurrent unclosed sessions once per session", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const ledger = {
        sessions: {
            sessionA: {
                id: "sessionA",
                state: STATE_OPEN,
                source: SOURCE_USAGE_EVENTS,
                totalNanoAiu: 3_000_000_000,
                lastSeenAt: now - 1_000,
            },
            sessionB: {
                id: "sessionB",
                state: STATE_OPEN,
                source: SOURCE_USAGE_EVENTS,
                totalNanoAiu: 2_000_000_000,
                lastSeenAt: now - 2_000,
            },
        },
    };

    assert.deepEqual(ledgerUsageEvents(ledger, now), [
        { at: now - 1_000, usd: 0.03, id: "sessionA" },
        { at: now - 2_000, usd: 0.02, id: "sessionB" },
    ]);
    assert.deepEqual(sessionLedgerWindows(ledger, now), {
        window24hUsd: 0.05,
        window7dUsd: 0.05,
        window30dUsd: 0.05,
    });
});

test("pruneLedger removes sessions outside the retention horizon", () => {
    const now = Date.UTC(2026, 11, 1, 12);
    const ledger = pruneLedger({
        sessions: {
            retainedClosed: { id: "retainedClosed", closedAt: now - 180 * day, totalNanoAiu: 1 },
            retainedOpen: { id: "retainedOpen", lastSeenAt: now - 179 * day },
            retainedUnknown: { id: "retainedUnknown", totalNanoAiu: 1 },
            oldClosed: { id: "oldClosed", closedAt: now - 181 * day, totalNanoAiu: 1 },
            oldFallback: { id: "oldFallback", firstSeenAt: now - 181 * day },
        },
    }, now);

    assert.deepEqual(Object.keys(ledger.sessions).sort(), [
        "retainedClosed",
        "retainedOpen",
        "retainedUnknown",
    ]);
});

test("mergeSession discovers null sessions without inventing a state", () => {
    const ledger = mergeSession({}, { id: "new-session", firstSeenAt: 10, lastSeenAt: 20 }, 30);

    assert.equal(ledger.sessions["new-session"].state, null);
    assert.equal(ledger.sessions["new-session"].source, "none");
    assert.equal(ledger.sessions["new-session"].lastUpdatedAt, undefined);
});
