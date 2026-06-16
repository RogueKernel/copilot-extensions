import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    currentSessionId,
    discoverSessionEventFiles,
    syncSessionLedger,
} from "../../src/domain/session-sync.mjs";
import {
    SOURCE_ESTIMATED_TOKENS,
    SOURCE_MODEL_METRICS,
    SOURCE_RUNTIME,
    SOURCE_SHUTDOWN,
    SOURCE_STATUSLINE,
    SOURCE_USAGE_EVENTS,
    STATE_AUTO_CLOSED,
    STATE_CLOSED,
    STATE_OPEN,
    SURFACE_CLI,
    SURFACE_VSCODE,
    sessionLedgerWindows,
} from "../../src/domain/session-ledger.mjs";

const day = 24 * 60 * 60 * 1000;

test("syncSessionLedger parses only new sessions and classifies closed/open/auto_closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await writeEvents(root, "closed", [
        event("session.shutdown", now - day, {
            totalNanoAiu: 2_000_000_000,
            modelMetrics: {
                "gpt-test": {
                    totalNanoAiu: 2_000_000_000,
                    usage: { inputTokens: 100 },
                },
            },
        }),
    ]);
    await writeEvents(root, "recent", [
        event("assistant.usage", now - 1_000, {
            model: "gpt-test",
            inputTokens: 10,
            copilotUsage: { totalNanoAiu: 100_000_000 },
        }),
    ]);
    await writeEvents(root, "stale", [
        event("assistant.usage", now - 8 * day, {
            model: "gpt-test",
            inputTokens: 50,
        }),
    ]);

    const ledger = await syncSessionLedger({ currentSessionId: "current", sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions.current.state, STATE_OPEN);
    assert.equal(ledger.sessions.closed.state, STATE_CLOSED);
    assert.equal(ledger.sessions.closed.source, SOURCE_SHUTDOWN);
    assert.equal(ledger.sessions.closed.totalNanoAiu, 2_000_000_000);
    assert.equal(ledger.sessions.recent.state, STATE_OPEN);
    assert.equal(ledger.sessions.recent.source, SOURCE_USAGE_EVENTS);
    assert.equal(ledger.sessions.recent.totalNanoAiu, 100_000_000);
    assert.equal(ledger.sessions.stale.state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions.stale.source, SOURCE_ESTIMATED_TOKENS);
    assert.equal(ledger.sessions.stale.totalNanoAiu, 1_000_000_000);
});

test("syncSessionLedger folds VS Code telemetry into the existing ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const vsCodeRoot = await mkdtemp(join(tmpdir(), "copilot-cost-vscode-user-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 5, 10, 12);
    const chatDir = join(vsCodeRoot, "workspaceStorage", "workspace-a", "chatSessions");
    await mkdir(chatDir, { recursive: true });
    await writeFile(join(chatDir, "session-vscode.jsonl"), [
        JSON.stringify({ kind: 0, v: { sessionId: "session-vscode", requests: [] } }),
        JSON.stringify({
            kind: 2,
            k: ["requests"],
            v: [{
                requestId: "request-vscode",
                timestamp: now - 1_000,
                result: {
                    details: "GPT-5.3-Codex • 2.4 credits",
                    metadata: {
                        sessionId: "session-vscode",
                        resolvedModel: "gpt-5.3-codex",
                        promptTokens: 100,
                        outputTokens: 10,
                    },
                },
            }],
        }),
    ].join("\n"));

    const ledger = await syncSessionLedger({
        currentSessionId: "current",
        sessionStateRoot: root,
        ledgerPath,
        vsCodeUserRoots: [vsCodeRoot],
        now,
    });
    const vsCode = Object.values(ledger.sessions).find((session) => session.id.startsWith("vscode:"));

    assert.equal(ledger.sessions.current.surface, SURFACE_CLI);
    assert.ok(vsCode);
    assert.equal(vsCode.surface, SURFACE_VSCODE);
    assert.equal(vsCode.state, STATE_OPEN);
    assert.equal(vsCode.source, SOURCE_USAGE_EVENTS);
    assert.equal(vsCode.totalNanoAiu, 2_400_000_000);
    assert.deepEqual(vsCode.modelMetrics["gpt-5.3-codex"], {
        totalNanoAiu: 2_400_000_000,
        tokenTotals: {
            inputTokens: 100,
            outputTokens: 10,
            requestCount: 1,
        },
    });
});

test("syncSessionLedger upgrades partial VS Code telemetry when final details arrive", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const vsCodeRoot = await mkdtemp(join(tmpdir(), "copilot-cost-vscode-user-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 5, 10, 12);
    const chatDir = join(vsCodeRoot, "workspaceStorage", "workspace-a", "chatSessions");
    const chatPath = join(chatDir, "session-vscode.jsonl");
    await mkdir(chatDir, { recursive: true });
    await writeFile(chatPath, [
        JSON.stringify({ kind: 0, v: { sessionId: "session-vscode", requests: [] } }),
        JSON.stringify({
            kind: 2,
            k: ["requests"],
            v: [{
                requestId: "request-vscode",
                timestamp: now - 1_000,
                result: { metadata: { sessionId: "session-vscode", outputTokens: 10 } },
            }],
        }),
    ].join("\n"));

    const partial = await syncSessionLedger({
        sessionStateRoot: root,
        ledgerPath,
        vsCodeUserRoots: [vsCodeRoot],
        now,
    });
    const partialVsCode = Object.values(partial.sessions).find((session) => session.id.startsWith("vscode:"));
    assert.ok(partialVsCode);
    assert.equal(partialVsCode.source, "none");
    assert.equal(partialVsCode.totalNanoAiu, undefined);
    assert.deepEqual(partialVsCode.tokenTotals, { outputTokens: 10, requestCount: 1 });

    await writeFile(chatPath, [
        JSON.stringify({ kind: 0, v: { sessionId: "session-vscode", requests: [] } }),
        JSON.stringify({
            kind: 2,
            k: ["requests"],
            v: [{
                requestId: "request-vscode",
                timestamp: now - 500,
                result: {
                    details: "Claude Opus 4.8 • 119.5 credits",
                    metadata: {
                        sessionId: "session-vscode",
                        resolvedModel: "copilot/claude-opus-4-8",
                        promptTokens: 34193,
                        outputTokens: 1875,
                    },
                },
            }],
        }),
    ].join("\n"));
    await touch(chatPath, now + 1_000);

    const final = await syncSessionLedger({
        sessionStateRoot: root,
        ledgerPath,
        vsCodeUserRoots: [vsCodeRoot],
        now: now + 2_000,
    });
    const finalVsCode = final.sessions[partialVsCode.id];
    assert.equal(finalVsCode.source, SOURCE_USAGE_EVENTS);
    assert.equal(finalVsCode.totalNanoAiu, 119_500_000_000);
    assert.deepEqual(finalVsCode.tokenTotals, {
        inputTokens: 34193,
        outputTokens: 1875,
        requestCount: 1,
    });
    assert.deepEqual(finalVsCode.modelMetrics["claude-opus-4.8"], {
        totalNanoAiu: 119_500_000_000,
        tokenTotals: {
            inputTokens: 34193,
            outputTokens: 1875,
            requestCount: 1,
        },
    });
});

test("syncSessionLedger skips new VS Code telemetry outside the retention horizon", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const vsCodeRoot = await mkdtemp(join(tmpdir(), "copilot-cost-vscode-user-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 11, 1, 12);
    const chatDir = join(vsCodeRoot, "workspaceStorage", "workspace-a", "chatSessions");
    const chatPath = join(chatDir, "old-session.jsonl");
    await mkdir(chatDir, { recursive: true });
    await writeFile(chatPath, [
        JSON.stringify({ kind: 0, v: { sessionId: "old-session", requests: [] } }),
        JSON.stringify({
            kind: 2,
            k: ["requests"],
            v: [{
                requestId: "old-request",
                timestamp: now - 181 * day,
                result: {
                    details: "GPT-5.3-Codex • 2.4 credits",
                    metadata: { sessionId: "old-session", resolvedModel: "gpt-5.3-codex" },
                },
            }],
        }),
    ].join("\n"));
    await touch(chatPath, now - 181 * day);

    const ledger = await syncSessionLedger({
        sessionStateRoot: root,
        ledgerPath,
        vsCodeUserRoots: [vsCodeRoot],
        now,
    });

    assert.equal(Object.values(ledger.sessions).some((session) => session.id.startsWith("vscode:")), false);
});

test("syncSessionLedger reparses stale open ledger rows when files changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await writeFile(ledgerPath, JSON.stringify({
        version: 1,
        sessions: {
            known: {
                id: "known",
                state: STATE_OPEN,
                totalNanoAiu: 123,
                source: SOURCE_STATUSLINE,
                lastSeenAt: now - 8 * day,
                lastUpdatedAt: now - 7 * day,
            },
        },
    }));
    await writeEvents(root, "known", [
        event("session.shutdown", now - day, {
            totalNanoAiu: 999_000_000_000,
            modelMetrics: {
                "gpt-test": {
                    totalNanoAiu: 999_000_000_000,
                    usage: { outputTokens: 100 },
                },
            },
        }),
    ]);

    const ledger = await syncSessionLedger({ sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions.known.state, STATE_CLOSED);
    assert.equal(ledger.sessions.known.source, SOURCE_SHUTDOWN);
    assert.equal(ledger.sessions.known.totalNanoAiu, 999_000_000_000);
    assert.deepEqual(ledger.sessions.known.modelMetrics, {
        "gpt-test": {
            totalNanoAiu: 999_000_000_000,
            tokenTotals: { outputTokens: 100 },
        },
    });
});

test("syncSessionLedger first run keeps recent no-shutdown sessions open and auto-closes stale history", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await writeEvents(root, "rate-profile", [
        event("session.shutdown", Date.UTC(2026, 5, 2, 12), {
            totalNanoAiu: 1_000_000_000,
            modelMetrics: {
                "gpt-test": {
                    totalNanoAiu: 1_000_000_000,
                    usage: { outputTokens: 100 },
                },
            },
        }),
    ]);
    await writeEvents(root, "stale-token-only", [
        event("assistant.usage", now - 10 * day, {
            model: "gpt-test",
            outputTokens: 50,
        }),
    ]);
    await writeEvents(root, "stale-message-output", [
        event("session.model_change", now - 11 * day, {
            newModel: "gpt-test",
        }),
        event("assistant.message", now - 11 * day + 1000, {
            outputTokens: 25,
        }),
    ]);
    await writeEvents(root, "recent-with-aiu", [
        event("assistant.usage", now - 2 * day, {
            model: "gpt-test",
            outputTokens: 20,
            copilotUsage: { totalNanoAiu: 2_000_000_000 },
        }),
    ]);
    await writeEvents(root, "recent-token-only", [
        event("assistant.usage", now - 2 * day, {
            model: "gpt-test",
            outputTokens: 30,
        }),
    ]);
    await writeEvents(root, "current-with-aiu", [
        event("assistant.usage", now - 1_000, {
            model: "gpt-test",
            outputTokens: 30,
            copilotUsage: { totalNanoAiu: 3_000_000_000 },
        }),
    ]);

    const ledger = await syncSessionLedger({ currentSessionId: "current-with-aiu", sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions["rate-profile"].state, STATE_CLOSED);
    assert.equal(ledger.sessions["rate-profile"].source, SOURCE_SHUTDOWN);
    assert.equal(ledger.sessions["stale-token-only"].state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions["stale-token-only"].source, SOURCE_ESTIMATED_TOKENS);
    assert.equal(ledger.sessions["stale-token-only"].totalNanoAiu, 500_000_000);
    assert.equal(ledger.sessions["stale-message-output"].state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions["stale-message-output"].source, SOURCE_ESTIMATED_TOKENS);
    assert.equal(ledger.sessions["stale-message-output"].totalNanoAiu, 250_000_000);
    assert.deepEqual(ledger.sessions["stale-message-output"].modelMetrics["gpt-test"].tokenTotals, { outputTokens: 25 });
    assert.equal(ledger.sessions["recent-with-aiu"].state, STATE_OPEN);
    assert.equal(ledger.sessions["recent-with-aiu"].source, SOURCE_USAGE_EVENTS);
    assert.equal(ledger.sessions["recent-with-aiu"].totalNanoAiu, 2_000_000_000);
    assert.equal(ledger.sessions["recent-token-only"].state, STATE_OPEN);
    assert.equal(ledger.sessions["recent-token-only"].source, "none");
    assert.equal(ledger.sessions["recent-token-only"].totalNanoAiu, undefined);
    assert.equal(ledger.sessions["recent-token-only"].modelMetrics["gpt-test"].totalNanoAiu, undefined);
    assert.deepEqual(ledger.sessions["recent-token-only"].modelMetrics["gpt-test"].tokenTotals, { outputTokens: 30 });
    assert.equal(ledger.sessions["current-with-aiu"].state, STATE_OPEN);
    assert.equal(ledger.sessions["current-with-aiu"].source, SOURCE_USAGE_EVENTS);
    assert.equal(ledger.sessions["current-with-aiu"].totalNanoAiu, 3_000_000_000);
});

test("syncSessionLedger keeps the current resumed session open even when its event file is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await writeEvents(root, "rate-profile", [
        event("session.shutdown", now - day, {
            totalNanoAiu: 1_000_000_000,
            modelMetrics: {
                "gpt-test": {
                    totalNanoAiu: 1_000_000_000,
                    usage: { outputTokens: 100 },
                },
            },
        }),
    ]);
    await writeEvents(root, "resumed", [
        event("assistant.usage", now - 10 * day, {
            model: "gpt-test",
            outputTokens: 50,
        }),
    ]);

    const ledger = await syncSessionLedger({ currentSessionId: "resumed", sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions.resumed.state, STATE_OPEN);
    assert.equal(ledger.sessions.resumed.source, "none");
    assert.equal(ledger.sessions.resumed.totalNanoAiu, undefined);
    assert.equal(ledger.sessions.resumed.lastSeenAt, now);
    assert.deepEqual(ledger.sessions.resumed.modelMetrics, {
        "gpt-test": {
            tokenTotals: { outputTokens: 50 },
        },
    });
});

test("syncSessionLedger marks the current session open even when no event file exists yet", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 5, 10, 12);

    const ledger = await syncSessionLedger({ currentSessionId: "current-no-file", sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions["current-no-file"].state, STATE_OPEN);
    assert.equal(ledger.sessions["current-no-file"].source, "none");
    assert.equal(ledger.sessions["current-no-file"].totalNanoAiu, undefined);
    assert.equal(ledger.sessions["current-no-file"].lastSeenAt, now);
});

test("syncSessionLedger trusts shutdown totals even when they are lower than live statusline totals", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await writeFile(ledgerPath, JSON.stringify({
        version: 1,
        sessions: {
            known: {
                id: "known",
                state: STATE_OPEN,
                totalNanoAiu: 10_000_000_000,
                source: SOURCE_STATUSLINE,
                lastSeenAt: now - 2 * day,
                lastUpdatedAt: now - 2 * day,
            },
        },
    }));
    await writeEvents(root, "known", [
        event("session.shutdown", now - day, {
            totalNanoAiu: 7_000_000_000,
            modelMetrics: {
                "gpt-test": {
                    totalNanoAiu: 7_000_000_000,
                    usage: { outputTokens: 70 },
                },
            },
        }),
    ]);

    const ledger = await syncSessionLedger({ sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions.known.state, STATE_CLOSED);
    assert.equal(ledger.sessions.known.source, SOURCE_SHUTDOWN);
    assert.equal(ledger.sessions.known.totalNanoAiu, 7_000_000_000);
});

test("syncSessionLedger rescans unpriced open sessions when shutdown totals appear later", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await writeFile(ledgerPath, JSON.stringify({
        version: 1,
        sessions: {
            known: {
                id: "known",
                state: STATE_OPEN,
                totalNanoAiu: 0,
                source: "none",
                firstSeenAt: now - 2 * day,
                lastSeenAt: now - 2 * day,
                lastUpdatedAt: now - 2 * day,
            },
        },
    }));
    await writeEvents(root, "known", [
        event("session.shutdown", now - day, {
            totalNanoAiu: 999_000_000_000,
            modelMetrics: {
                "gpt-test": {
                    totalNanoAiu: 999_000_000_000,
                    usage: { outputTokens: 100 },
                },
            },
        }),
    ]);

    const ledger = await syncSessionLedger({ sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions.known.state, STATE_CLOSED);
    assert.equal(ledger.sessions.known.source, SOURCE_SHUTDOWN);
    assert.equal(ledger.sessions.known.totalNanoAiu, 999_000_000_000);
});

test("syncSessionLedger rescans unpriced open sessions to retain usage AIU and model detail without shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await writeFile(ledgerPath, JSON.stringify({
        version: 1,
        sessions: {
            known: {
                id: "known",
                state: STATE_OPEN,
                totalNanoAiu: 0,
                source: "none",
                firstSeenAt: now - 2 * day,
                lastSeenAt: now - 2 * day,
                lastUpdatedAt: now - 2 * day,
            },
        },
    }));
    await writeEvents(root, "known", [
        event("assistant.usage", now - day, {
            model: "gpt-test",
            outputTokens: 100,
            copilotUsage: { totalNanoAiu: 1_000_000_000 },
        }),
    ]);

    const ledger = await syncSessionLedger({ sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions.known.state, STATE_OPEN);
    assert.equal(ledger.sessions.known.source, SOURCE_USAGE_EVENTS);
    assert.equal(ledger.sessions.known.totalNanoAiu, 1_000_000_000);
    assert.deepEqual(ledger.sessions.known.modelMetrics, {
        "gpt-test": {
            totalNanoAiu: 1_000_000_000,
            tokenTotals: { outputTokens: 100 },
        },
    });
});

test("syncSessionLedger lets shutdown totals replace known usage-event totals", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await writeFile(ledgerPath, JSON.stringify({
        version: 1,
        sessions: {
            known: {
                id: "known",
                state: STATE_OPEN,
                totalNanoAiu: 1_000_000_000,
                source: SOURCE_USAGE_EVENTS,
                firstSeenAt: now - 3 * day,
                lastSeenAt: now - 2 * day,
                lastUpdatedAt: now - 2 * day,
                lastScannedAt: now - 2 * day,
                modelMetrics: {
                    "gpt-test": {
                        totalNanoAiu: 1_000_000_000,
                        tokenTotals: { outputTokens: 10 },
                    },
                },
            },
        },
    }));
    await writeEvents(root, "known", [
        event("assistant.usage", now - 2 * day, {
            model: "gpt-test",
            outputTokens: 10,
            copilotUsage: { totalNanoAiu: 1_000_000_000 },
        }),
        event("session.shutdown", now - day, {
            totalNanoAiu: 9_000_000_000,
            modelMetrics: {
                "gpt-test": {
                    totalNanoAiu: 9_000_000_000,
                    usage: { outputTokens: 20 },
                },
            },
        }),
    ]);

    const ledger = await syncSessionLedger({ sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions.known.state, STATE_CLOSED);
    assert.equal(ledger.sessions.known.source, SOURCE_SHUTDOWN);
    assert.equal(ledger.sessions.known.totalNanoAiu, 9_000_000_000);
    assert.deepEqual(ledger.sessions.known.modelMetrics, {
        "gpt-test": {
            totalNanoAiu: 9_000_000_000,
            tokenTotals: { outputTokens: 20 },
        },
    });
});

test("syncSessionLedger trusts shutdown totals even when they are lower than observed usage totals", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await writeFile(ledgerPath, JSON.stringify({
        version: 1,
        sessions: {
            known: {
                id: "known",
                state: STATE_OPEN,
                totalNanoAiu: 5_000_000_000,
                source: SOURCE_USAGE_EVENTS,
                firstSeenAt: now - 3 * day,
                lastSeenAt: now - 2 * day,
                lastUpdatedAt: now - 2 * day,
                modelMetrics: {
                    "gpt-test": {
                        totalNanoAiu: 5_000_000_000,
                        tokenTotals: { outputTokens: 50 },
                    },
                },
            },
        },
    }));
    await writeEvents(root, "known", [
        event("assistant.usage", now - 2 * day, {
            model: "gpt-test",
            outputTokens: 50,
            copilotUsage: { totalNanoAiu: 5_000_000_000 },
        }),
        event("session.shutdown", now - day, {
            totalNanoAiu: 4_000_000_000,
            modelMetrics: {
                "gpt-test": {
                    totalNanoAiu: 4_000_000_000,
                    usage: { outputTokens: 40 },
                },
            },
        }),
    ]);

    const ledger = await syncSessionLedger({ sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions.known.state, STATE_CLOSED);
    assert.equal(ledger.sessions.known.source, SOURCE_SHUTDOWN);
    assert.equal(ledger.sessions.known.totalNanoAiu, 4_000_000_000);
});

test("syncSessionLedger rescans open usage-event sessions when more usage arrives without shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await writeFile(ledgerPath, JSON.stringify({
        version: 1,
        sessions: {
            known: {
                id: "known",
                state: STATE_OPEN,
                totalNanoAiu: 1_000_000_000,
                source: SOURCE_USAGE_EVENTS,
                firstSeenAt: now - 3 * day,
                lastSeenAt: now - 2 * day,
                lastUpdatedAt: now - 2 * day,
                lastScannedAt: now - 2 * day,
                eventFileSize: 100,
                modelMetrics: {
                    "gpt-test": {
                        totalNanoAiu: 1_000_000_000,
                        tokenTotals: { outputTokens: 10 },
                    },
                },
            },
        },
    }));
    await writeEvents(root, "known", [
        event("assistant.usage", now - 2 * day, {
            model: "gpt-test",
            outputTokens: 10,
            copilotUsage: { totalNanoAiu: 1_000_000_000 },
        }),
        event("assistant.usage", now - day, {
            model: "gpt-test",
            outputTokens: 20,
            copilotUsage: { totalNanoAiu: 2_000_000_000 },
        }),
    ]);

    const ledger = await syncSessionLedger({ sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions.known.state, STATE_OPEN);
    assert.equal(ledger.sessions.known.source, SOURCE_USAGE_EVENTS);
    assert.equal(ledger.sessions.known.totalNanoAiu, 3_000_000_000);
    assert.deepEqual(ledger.sessions.known.modelMetrics, {
        "gpt-test": {
            totalNanoAiu: 3_000_000_000,
            tokenTotals: { outputTokens: 30 },
        },
    });
});

test("syncSessionLedger keeps concurrent unclosed sessions cumulative without double counting", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await writeEvents(root, "active-a", [
        event("assistant.usage", now - 10_000, {
            model: "gpt-test",
            copilotUsage: { totalNanoAiu: 1_000_000_000 },
        }),
    ]);
    await writeEvents(root, "active-b", [
        event("assistant.usage", now - 9_000, {
            model: "gpt-test",
            copilotUsage: { totalNanoAiu: 2_000_000_000 },
        }),
    ]);

    const first = await syncSessionLedger({ currentSessionId: "active-a", sessionStateRoot: root, ledgerPath, now });

    assert.equal(first.sessions["active-a"].state, STATE_OPEN);
    assert.equal(first.sessions["active-b"].state, STATE_OPEN);
    assert.equal(first.sessions["active-a"].totalNanoAiu, 1_000_000_000);
    assert.equal(first.sessions["active-b"].totalNanoAiu, 2_000_000_000);
    assert.deepEqual(sessionLedgerWindows(first, now), {
        window24hUsd: 0.03,
        window7dUsd: 0.03,
        window30dUsd: 0.03,
    });

    await writeEvents(root, "active-a", [
        event("assistant.usage", now - 10_000, {
            model: "gpt-test",
            copilotUsage: { totalNanoAiu: 1_000_000_000 },
        }),
        event("assistant.usage", now - 1_000, {
            model: "gpt-test",
            copilotUsage: { totalNanoAiu: 1_000_000_000 },
        }),
    ]);

    const second = await syncSessionLedger({ currentSessionId: "active-a", sessionStateRoot: root, ledgerPath, now });

    assert.equal(second.sessions["active-a"].totalNanoAiu, 2_000_000_000);
    assert.equal(second.sessions["active-b"].totalNanoAiu, 2_000_000_000);
    assert.deepEqual(sessionLedgerWindows(second, now), {
        window24hUsd: 0.04,
        window7dUsd: 0.04,
        window30dUsd: 0.04,
    });
    assert.equal(Object.keys(second.sessions).filter((id) => id === "active-a").length, 1);
    assert.equal(Object.keys(second.sessions).filter((id) => id === "active-b").length, 1);
});

test("syncSessionLedger folds runtime official totals for concurrent open sessions into cached windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const dir = await mkdtemp(join(tmpdir(), "copilot-cost-data-"));
    const ledgerPath = join(dir, "session-ledger.json");
    const summaryPath = join(dir, "summary-state.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await writeEvents(root, "active-a", [
        event("assistant.message", now - 2_000, {
            model: "gpt-test",
            outputTokens: 5,
        }),
    ]);
    await writeEvents(root, "active-b", [
        event("assistant.message", now - 1_000, {
            model: "gpt-test",
            outputTokens: 10,
        }),
    ]);
    await writeFile(summaryPath, JSON.stringify({
        version: 1,
        windows: { window24hUsd: 0, window7dUsd: 0, window30dUsd: 0, updatedAt: now - 10 * 60 * 1000 },
        runtime: {
            left: {
                sessionId: "active-a",
                officialTotalUsd: 4.10,
                totalUsd: 4.20,
                lastTurnAt: now - 2_000,
            },
            right: {
                sessionId: "active-b",
                officialTotalUsd: 0.13,
                totalUsd: 0.14,
                lastTurnAt: now - 1_000,
            },
        },
    }));

    const ledger = await syncSessionLedger({
        currentSessionId: "active-b",
        sessionStateRoot: root,
        ledgerPath,
        summaryPath,
        now,
    });
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));

    assert.equal(ledger.sessions["active-a"].source, SOURCE_RUNTIME);
    assert.equal(ledger.sessions["active-a"].totalNanoAiu, 410_000_000_000);
    assert.equal(ledger.sessions["active-a"].windowAt, now - 2_000);
    assert.equal(ledger.sessions["active-b"].source, SOURCE_RUNTIME);
    assert.equal(ledger.sessions["active-b"].totalNanoAiu, 13_000_000_000);
    assert.deepEqual(summary.windows, {
        window24hUsd: 4.2299999999999995,
        window7dUsd: 4.2299999999999995,
        window30dUsd: 4.2299999999999995,
        updatedAt: now,
    });
});

test("syncSessionLedger rescans source-none sessions when file size changes despite near-identical mtimes", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await writeFile(ledgerPath, JSON.stringify({
        version: 1,
        sessions: {
            known: {
                id: "known",
                state: STATE_OPEN,
                totalNanoAiu: 0,
                source: "none",
                firstSeenAt: now - 2 * day,
                lastSeenAt: now - 2 * day,
                lastScannedAt: now,
                eventFileSize: 10,
            },
        },
    }));
    await writeEvents(root, "known", [
        event("session.shutdown", now - 500, { totalNanoAiu: 7_000_000_000 }),
    ]);
    await touch(join(root, "known", "events.jsonl"), now - 500);

    const ledger = await syncSessionLedger({ sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions.known.state, STATE_CLOSED);
    assert.equal(ledger.sessions.known.source, SOURCE_SHUTDOWN);
    assert.equal(ledger.sessions.known.totalNanoAiu, 7_000_000_000);
});

test("syncSessionLedger reparses auto-closed rows when files changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await writeFile(ledgerPath, JSON.stringify({
        version: 1,
        sessions: {
            known: {
                id: "known",
                state: STATE_AUTO_CLOSED,
                totalNanoAiu: 500_000_000,
                source: SOURCE_ESTIMATED_TOKENS,
                lastSeenAt: now - 8 * day,
                lastUpdatedAt: now - day,
                estimateConfidence: "low",
            },
        },
    }));
    await writeEvents(root, "known", [
        event("session.shutdown", now - 1000, {
            totalNanoAiu: 5_000_000_000,
            modelMetrics: {
                "gpt-test": {
                    totalNanoAiu: 5_000_000_000,
                    usage: { outputTokens: 50 },
                },
            },
        }),
    ]);

    const ledger = await syncSessionLedger({ sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions.known.state, STATE_CLOSED);
    assert.equal(ledger.sessions.known.source, SOURCE_SHUTDOWN);
    assert.equal(ledger.sessions.known.totalNanoAiu, 5_000_000_000);
    assert.equal(ledger.sessions.known.estimateConfidence, undefined);
});

test("syncSessionLedger trusts unchanged auto-closed rows without reparsing", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await writeEvents(root, "known", [
        event("session.shutdown", now - 1000, { totalNanoAiu: 5_000_000_000 }),
    ]);
    const details = await fileDetails(join(root, "known", "events.jsonl"));
    await writeFile(ledgerPath, JSON.stringify({
        version: 1,
        sessions: {
            known: {
                id: "known",
                state: STATE_AUTO_CLOSED,
                totalNanoAiu: 500_000_000,
                source: SOURCE_ESTIMATED_TOKENS,
                lastSeenAt: now - 8 * day,
                lastUpdatedAt: now - day,
                eventFileMtimeMs: details.mtimeMs,
                eventFileSize: details.size,
                estimateConfidence: "low",
            },
        },
    }));

    const ledger = await syncSessionLedger({ sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions.known.state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions.known.source, SOURCE_ESTIMATED_TOKENS);
    assert.equal(ledger.sessions.known.totalNanoAiu, 500_000_000);
    assert.equal(ledger.sessions.known.estimateConfidence, "low");
});

test("syncSessionLedger reparses model-metrics fallback closures when files changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await writeFile(ledgerPath, JSON.stringify({
        version: 1,
        sessions: {
            known: {
                id: "known",
                state: STATE_CLOSED,
                totalNanoAiu: 2_000_000_000,
                source: SOURCE_MODEL_METRICS,
                closedAt: now - 2 * day,
                lastSeenAt: now - 2 * day,
                modelMetrics: {
                    "gpt-test": {
                        totalNanoAiu: 2_000_000_000,
                        tokenTotals: { outputTokens: 20 },
                    },
                },
            },
        },
    }));
    await writeEvents(root, "known", [
        event("session.shutdown", now - day, {
            totalNanoAiu: 3_000_000_000,
            modelMetrics: {
                "gpt-test": {
                    totalNanoAiu: 3_000_000_000,
                    usage: { outputTokens: 30 },
                },
            },
        }),
    ]);

    const ledger = await syncSessionLedger({ sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions.known.state, STATE_CLOSED);
    assert.equal(ledger.sessions.known.source, SOURCE_SHUTDOWN);
    assert.equal(ledger.sessions.known.totalNanoAiu, 3_000_000_000);
    assert.equal(ledger.sessions.known.closedAt, now - day);
});

test("syncSessionLedger trusts unchanged shutdown rows without reparsing to backfill model metrics", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await writeEvents(root, "known", [
        event("session.shutdown", now - day, {
            totalNanoAiu: 8_000_000_000,
            modelMetrics: {
                "gpt-test": {
                    totalNanoAiu: 8_000_000_000,
                    usage: {
                        inputTokens: 100,
                        cacheReadTokens: 20,
                        outputTokens: 10,
                    },
                },
            },
        }),
    ]);
    const details = await fileDetails(join(root, "known", "events.jsonl"));
    await writeFile(ledgerPath, JSON.stringify({
        version: 1,
        sessions: {
            known: {
                id: "known",
                state: STATE_CLOSED,
                totalNanoAiu: 8_000_000_000,
                source: SOURCE_SHUTDOWN,
                closedAt: now - day,
                lastSeenAt: now - day,
                eventFileMtimeMs: details.mtimeMs,
                eventFileSize: details.size,
            },
        },
    }));

    const ledger = await syncSessionLedger({ sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions.known.state, STATE_CLOSED);
    assert.equal(ledger.sessions.known.source, SOURCE_SHUTDOWN);
    assert.equal(ledger.sessions.known.totalNanoAiu, 8_000_000_000);
    assert.deepEqual(ledger.sessions.known.modelMetrics, {});
});

test("syncSessionLedger scans new sessions within the 180-day retention horizon", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 11, 1, 12);
    await writeEvents(root, "within-history", [
        event("session.shutdown", now - 179 * day, { totalNanoAiu: 1_000_000_000 }),
    ]);
    await writeEvents(root, "outside-history", [
        event("session.shutdown", now - 181 * day, { totalNanoAiu: 2_000_000_000 }),
    ]);
    await touch(join(root, "within-history", "events.jsonl"), now - 179 * day);
    await touch(join(root, "outside-history", "events.jsonl"), now - 181 * day);

    const ledger = await syncSessionLedger({ sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions["within-history"].state, STATE_CLOSED);
    assert.equal(ledger.sessions["within-history"].totalNanoAiu, 1_000_000_000);
    assert.equal(ledger.sessions["outside-history"], undefined);
});

test("syncSessionLedger prunes existing sessions outside the retention horizon", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 11, 1, 12);
    await writeFile(ledgerPath, JSON.stringify({
        version: 1,
        sessions: {
            retained: {
                id: "retained",
                state: STATE_CLOSED,
                source: SOURCE_SHUTDOWN,
                totalNanoAiu: 1_000_000_000,
                closedAt: now - 180 * day,
            },
            old: {
                id: "old",
                state: STATE_CLOSED,
                source: SOURCE_SHUTDOWN,
                totalNanoAiu: 2_000_000_000,
                closedAt: now - 181 * day,
            },
        },
    }));

    const ledger = await syncSessionLedger({ sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions.retained.totalNanoAiu, 1_000_000_000);
    assert.equal(ledger.sessions.old, undefined);
});

test("syncSessionLedger does not rescan changed CLI files when latest event is outside the retention horizon", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 11, 1, 12);
    await writeFile(ledgerPath, JSON.stringify({
        version: 1,
        sessions: {
            old: {
                id: "old",
                state: STATE_CLOSED,
                source: SOURCE_SHUTDOWN,
                totalNanoAiu: 1_000_000_000,
                closedAt: now - 181 * day,
                eventFileMtimeMs: now - 181 * day,
                eventFileSize: 1,
            },
        },
    }));
    await writeEvents(root, "old", [
        event("session.shutdown", now - 181 * day, { totalNanoAiu: 9_000_000_000 }),
    ]);
    await touch(join(root, "old", "events.jsonl"), now);

    const ledger = await syncSessionLedger({ sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions.old, undefined);
});

test("syncSessionLedger does not rescan changed VS Code telemetry outside the retention horizon", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const vsCodeRoot = await mkdtemp(join(tmpdir(), "copilot-cost-vscode-user-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 11, 1, 12);
    const chatDir = join(vsCodeRoot, "workspaceStorage", "workspace-a", "chatSessions");
    const chatPath = join(chatDir, "old-session.jsonl");
    await mkdir(chatDir, { recursive: true });
    await writeFile(chatPath, [
        JSON.stringify({ kind: 0, v: { sessionId: "old-session", requests: [] } }),
        JSON.stringify({
            kind: 2,
            k: ["requests"],
            v: [{
                requestId: "old-request",
                timestamp: now - 181 * day,
                result: {
                    details: "GPT-5.3-Codex - 9 credits",
                    metadata: { sessionId: "old-session", resolvedModel: "gpt-5.3-codex" },
                },
            }],
        }),
    ].join("\n"));
    await touch(chatPath, now - 181 * day);
    await writeFile(ledgerPath, JSON.stringify({
        version: 1,
        sessions: {
            "vscode:prior:workspace-a:old-session": {
                id: "vscode:prior:workspace-a:old-session",
                state: STATE_CLOSED,
                surface: SURFACE_VSCODE,
                source: SOURCE_SHUTDOWN,
                totalNanoAiu: 1_000_000_000,
                closedAt: now - 181 * day,
                eventFileMtimeMs: now - 181 * day,
                eventFileSize: 1,
            },
        },
    }));

    const ledger = await syncSessionLedger({
        sessionStateRoot: root,
        ledgerPath,
        vsCodeUserRoots: [vsCodeRoot],
        now,
    });

    assert.deepEqual(Object.values(ledger.sessions).filter((session) => session.surface === SURFACE_VSCODE), []);
});

test("syncSessionLedger values pre-usage-based sessions from retained token profiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await writeEvents(root, "priced", [
        event("session.shutdown", Date.UTC(2026, 5, 2, 12), {
            totalNanoAiu: 1_000_000_000,
            modelMetrics: {
                "gpt-test": {
                    totalNanoAiu: 1_000_000_000,
                    usage: { outputTokens: 100 },
                },
            },
        }),
    ]);
    await writeEvents(root, "pre-pricing", [
        event("session.shutdown", Date.UTC(2026, 4, 31, 12), {
            totalNanoAiu: 50_000_000_000,
            modelMetrics: {
                "gpt-test": {
                    totalNanoAiu: 50_000_000_000,
                    usage: { outputTokens: 50 },
                },
            },
        }),
    ]);
    await touch(join(root, "priced", "events.jsonl"), Date.UTC(2026, 5, 2, 12));
    await touch(join(root, "pre-pricing", "events.jsonl"), Date.UTC(2026, 4, 31, 12));

    const ledger = await syncSessionLedger({ sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions.priced.state, STATE_CLOSED);
    assert.equal(ledger.sessions["pre-pricing"].state, STATE_CLOSED);
    assert.equal(ledger.sessions["pre-pricing"].source, SOURCE_SHUTDOWN);
    assert.equal(ledger.sessions["pre-pricing"].totalNanoAiu, 50_000_000_000);
});

test("discoverSessionEventFiles ignores missing roots and sorts newest first", async () => {
    assert.deepEqual(await discoverSessionEventFiles(join(tmpdir(), "missing-copilot-session-root")), []);

    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    await writeEvents(root, "older", [event("session.shutdown", Date.UTC(2026, 5, 1), {})]);
    await writeEvents(root, "newer", [event("session.shutdown", Date.UTC(2026, 5, 2), {})]);
    await touch(join(root, "older", "events.jsonl"), Date.UTC(2026, 5, 1));
    await touch(join(root, "newer", "events.jsonl"), Date.UTC(2026, 5, 2));

    assert.deepEqual((await discoverSessionEventFiles(root)).map((file) => file.id), ["newer", "older"]);
});

test("currentSessionId prefers explicit ids and otherwise reads session-state paths", () => {
    assert.equal(currentSessionId({ sessionId: "explicit" }), "explicit");
    assert.equal(currentSessionId({ id: "fallback" }), "fallback");
    assert.equal(currentSessionId({ workspacePath: "/tmp/session-state/abc" }), "abc");
    assert.equal(currentSessionId({ workspacePath: "/tmp/project" }), undefined);
});

async function writeEvents(root, id, events) {
    const dir = join(root, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "events.jsonl"), `${events.map((item) => JSON.stringify(item)).join("\n")}\n`);
}

function event(type, timestamp, data) {
    return { type, timestamp: new Date(timestamp).toISOString(), data };
}

async function touch(path, at) {
    const date = new Date(at);
    await utimes(path, date, date);
    await readFile(path);
}

async function fileDetails(path) {
    const details = await stat(path);
    return { mtimeMs: details.mtimeMs, size: details.size };
}
