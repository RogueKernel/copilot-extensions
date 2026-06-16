import test from "node:test";
import assert from "node:assert/strict";

import {
    createSessionRuntime,
    finalizeCompaction,
    finalizeTurn,
    runExtension,
    syncCurrentSessionLedgerIfWindowsStale,
} from "../../src/runtime/extension.mjs";

test("runExtension registers /cost and attaches session handlers", async () => {
    const session = new FakeSession();
    let joinOptions;
    let startupRuns = 0;

    await runExtension({
        startupTasks: async () => {
            startupRuns += 1;
        },
        importSdk: async () => ({
            joinSession: async (options) => {
                joinOptions = options;
                return session;
            },
        }),
    });

    assert.equal(joinOptions.commands[0].name, "cost");
    assert.equal(startupRuns, 1);
    assert.deepEqual(session.eventNames(), [
        "assistant.turn_start",
        "assistant.usage",
        "session.compaction_complete",
        "session.idle",
        "session.usage_info",
        "user.message",
    ]);
});

test("createSessionRuntime wires the /cost command to the attached session", async () => {
    const session = new FakeSession();
    const calls = [];
    const runtime = createSessionRuntime({
        configure: async (activeSession, context) => calls.push({ activeSession, context }),
    });

    const options = runtime.joinOptions();
    runtime.attach(session);
    await options.commands[0].handler({ args: "off" });

    assert.deepEqual(options.tools, []);
    assert.equal(options.commands[0].description, "Show cost overview and settings");
    assert.equal(calls[0].activeSession, session);
    assert.deepEqual(calls[0].context, { args: "off" });
});

test("createSessionRuntime starts ledger sync after startup tasks when the session id is known", async () => {
    const session = new FakeSession("/tmp/session-state/session-a");
    const calls = [];
    const runtime = createSessionRuntime({
        runStartupTasks: async () => calls.push({ startup: true }),
        syncSessionLedger: async (context) => calls.push(context),
    });

    runtime.attach(session);
    await flushAsyncHandlers();

    assert.deepEqual(calls, [{ startup: true }, { currentSessionId: "session-a" }]);
});

test("session runtime waits for startup reset before writing summary state", async () => {
    const session = new FakeSession("/tmp/session-state/session-a");
    const startup = deferred();
    const merged = [];
    const runtime = createSessionRuntime({
        runStartupTasks: async () => startup.promise,
        mergeState: async (workspace, patch) => {
            merged.push({ workspace, patch });
            return patch;
        },
        syncSessionLedger: async () => {},
    });

    runtime.attach(session);
    session.emit("session.usage_info", { data: { currentTokens: 1200, tokenLimit: 200000 } });
    await flushAsyncHandlers();

    assert.deepEqual(merged, []);

    startup.resolve();
    await flushAsyncHandlers();

    assert.deepEqual(merged, [{
        workspace: "/tmp/session-state/session-a",
        patch: {
            sessionId: "session-a",
            contextTokens: 1200,
            contextTokenLimit: 200000,
        },
    }]);
});

test("session runtime persists one user turn and logs message output", async () => {
    const session = new FakeSession("/workspace");
    const merged = [];
    const runtime = createSessionRuntime({
        runStartupTasks: noopFirstRun,
        readState: async (workspace) => {
            assert.equal(workspace, "/workspace");
            return { officialTotalUsd: 1, pendingUsd: 0, totalUsd: 1 };
        },
        mergeState: async (workspace, patch) => {
            merged.push({ workspace, patch });
            return { ...patch, totalUsd: 1.02 };
        },
        refreshUsageWindows: async () => ({ window24hUsd: 0.02 }),
        readSettings: async () => ({ mode: "message", unit: "usd", messageFormat: "{cost}" }),
        runFirstRunTasks: async ({ workspacePath, priorState }) => {
            assert.equal(workspacePath, "/workspace");
            assert.deepEqual(priorState, { officialTotalUsd: 1, pendingUsd: 0, totalUsd: 1 });
        },
        renderSummary: (state, options) => {
            assert.equal(state.window24hUsd, 0.02);
            assert.equal(options.unit, "usd");
            return `summary ${state.totalUsd}`;
        },
    });

    runtime.attach(session);
    session.emit("user.message", { timestamp: "2026-01-01T00:00:00.000Z" });
    session.emit("session.usage_info", { data: { currentTokens: 1200, tokenLimit: 200000 } });
    session.emit("assistant.usage", usageEvent({ totalNanoAiu: 2_000_000_000 }));
    session.emit("session.idle", { timestamp: "2026-01-01T00:00:02.000Z" });
    await flushAsyncHandlers();

    assert.equal(merged.length, 2);
    assert.deepEqual(merged[0], {
        workspace: "/workspace",
        patch: { contextTokens: 1200, contextTokenLimit: 200000 },
    });
    assert.equal(merged[1].workspace, "/workspace");
    assert.equal(merged[1].patch.lastUsd, 0.02);
    assert.equal(merged[1].patch.contextTokens, 1200);
    assert.equal(merged[1].patch.contextTokenLimit, 200000);
    assert.equal(merged[1].patch.window24hUsd, undefined);
    assert.deepEqual(session.logs, ["summary 1.02"]);

    session.emit("session.idle", { timestamp: "2026-01-01T00:00:03.000Z" });
    await flushAsyncHandlers();
    assert.equal(merged.length, 2);
});

test("session runtime waits for session idle before logging message output", async () => {
    const session = new FakeSession("/workspace");
    const merged = [];
    const firstRuns = [];
    const runtime = createSessionRuntime({
        runStartupTasks: noopFirstRun,
        readState: async () => undefined,
        mergeState: async (workspace, patch) => {
            merged.push({ workspace, patch });
            return { ...patch, totalUsd: 1.02 };
        },
        readSettings: async () => ({ mode: "message", unit: "usd", messageFormat: "{cost}" }),
        refreshUsageWindows: noWindowRefresh,
        runFirstRunTasks: async (context) => {
            firstRuns.push(context);
        },
        renderSummary: (state) => `summary ${state.totalUsd}`,
    });

    runtime.attach(session);
    session.emit("user.message", { timestamp: "2026-01-01T00:00:00.000Z" });
    session.emit("assistant.turn_start", { timestamp: "2026-01-01T00:00:01.000Z" });
    session.emit("assistant.usage", usageEvent({ totalNanoAiu: 1_000_000_000 }));
    session.emit("assistant.turn_end", { timestamp: "2026-01-01T00:00:02.000Z" });
    await flushAsyncHandlers();

    assert.equal(merged.length, 0);
    assert.deepEqual(session.logs, []);

    session.emit("assistant.usage", usageEvent({ totalNanoAiu: 1_000_000_000 }));
    session.emit("assistant.turn_end", { timestamp: "2026-01-01T00:00:03.000Z" });
    await flushAsyncHandlers();

    assert.equal(merged.length, 0);
    assert.deepEqual(session.logs, []);

    session.emit("session.idle", { timestamp: "2026-01-01T00:00:04.000Z" });
    await flushAsyncHandlers();

    assert.equal(merged.length, 1);
    assert.equal(merged[0].patch.lastNanoAiu, 2_000_000_000);
    assert.equal(merged[0].patch.lastDurationMs, 4_000);
    assert.deepEqual(firstRuns, [{ workspacePath: "/workspace", priorState: undefined }]);
    assert.deepEqual(session.logs, ["summary 1.02"]);
});

test("session runtime keeps one accumulator when the user steers before idle", async () => {
    const session = new FakeSession("/workspace");
    const merged = [];
    const runtime = createSessionRuntime({
        runStartupTasks: noopFirstRun,
        readState: async () => undefined,
        mergeState: async (workspace, patch) => {
            merged.push({ workspace, patch });
            return { ...patch, totalUsd: 1.03 };
        },
        readSettings: async () => ({ mode: "message", unit: "usd", messageFormat: "{cost}" }),
        refreshUsageWindows: noWindowRefresh,
        runFirstRunTasks: noopFirstRun,
        renderSummary: (state) => `summary ${state.totalUsd}`,
    });

    runtime.attach(session);
    session.emit("user.message", { timestamp: "2026-01-01T00:00:00.000Z" });
    session.emit("assistant.turn_start", { timestamp: "2026-01-01T00:00:01.000Z" });
    session.emit("assistant.usage", usageEvent({ totalNanoAiu: 1_000_000_000 }));

    session.emit("user.message", { timestamp: "2026-01-01T00:00:02.000Z" });
    session.emit("assistant.usage", usageEvent({ totalNanoAiu: 2_000_000_000 }));
    session.emit("session.idle", { timestamp: "2026-01-01T00:00:04.000Z" });
    await flushAsyncHandlers();

    assert.equal(merged.length, 1);
    assert.equal(merged[0].patch.lastNanoAiu, 3_000_000_000);
    assert.equal(merged[0].patch.lastDurationMs, 4_000);
    assert.deepEqual(session.logs, ["summary 1.03"]);
});

test("session runtime adds observed usage to prior conversation total", async () => {
    const session = new FakeSession("/workspace");
    const merged = [];
    const runtime = createSessionRuntime({
        runStartupTasks: noopFirstRun,
        readState: async () => ({ officialTotalUsd: 0.9, pendingUsd: 0, totalUsd: 0.9 }),
        mergeState: async (workspace, patch) => {
            merged.push({ workspace, patch });
            return patch;
        },
        readSettings: async () => ({ mode: "message", unit: "usd", messageFormat: "{cost}" }),
        refreshUsageWindows: noWindowRefresh,
        runFirstRunTasks: noopFirstRun,
        renderSummary: (state) => `summary ${state.totalUsd}`,
    });

    runtime.attach(session);
    session.emit("user.message", { timestamp: "2026-01-01T00:00:00.000Z" });
    await flushAsyncHandlers();

    session.emit("assistant.usage", usageEvent({ totalNanoAiu: 90_000_000_000 }));
    session.emit("session.idle", { timestamp: "2026-01-01T00:00:04.000Z" });
    await flushAsyncHandlers();

    assert.equal(merged.length, 1);
    assert.equal(merged[0].patch.lastUsd, 0.9);
    assert.equal(merged[0].patch.totalUsd, 1.8);
    assert.equal(merged[0].patch.officialTotalUsd, 0.9);
    assert.equal(merged[0].patch.pendingUsd, 0.9);
    assert.deepEqual(session.logs, ["summary 1.8"]);
});

test("session runtime includes sub-agent usage in the parent turn", async () => {
    const session = new FakeSession("/workspace");
    const merged = [];
    const runtime = createSessionRuntime({
        runStartupTasks: noopFirstRun,
        readState: async () => undefined,
        mergeState: async (workspace, patch) => {
            merged.push({ workspace, patch });
            return patch;
        },
        readSettings: async () => ({ mode: "message", unit: "usd", messageFormat: "{cost}" }),
        refreshUsageWindows: noWindowRefresh,
        runFirstRunTasks: noopFirstRun,
        renderSummary: (state) => `summary ${state.totalUsd}`,
    });

    runtime.attach(session);
    session.emit("user.message", { timestamp: "2026-01-01T00:00:00.000Z" });
    session.emit("assistant.turn_start", { timestamp: "2026-01-01T00:00:01.000Z" });
    session.emit("assistant.usage", usageEvent({ totalNanoAiu: 1_000_000_000 }));

    session.emit("assistant.turn_start", { agentId: "agent-a", timestamp: "2026-01-01T00:00:02.000Z" });
    session.emit("assistant.usage", { agentId: "agent-a", ...usageEvent({ totalNanoAiu: 2_000_000_000 }) });
    session.emit("assistant.turn_end", { agentId: "agent-a", timestamp: "2026-01-01T00:00:03.000Z" });

    session.emit("assistant.usage", usageEvent({ totalNanoAiu: 3_000_000_000 }));
    session.emit("session.idle", { timestamp: "2026-01-01T00:00:04.000Z" });
    await flushAsyncHandlers();

    assert.equal(merged.length, 1);
    assert.equal(merged[0].patch.lastNanoAiu, 6_000_000_000);
    assert.equal(merged[0].patch.lastDurationMs, 4_000);
    assert.deepEqual(session.logs, ["summary 0.06"]);
});

test("session runtime ignores agent-owned lifecycle events", async () => {
    const session = new FakeSession();
    const merged = [];
    const runtime = createSessionRuntime({
        mergeState: async (workspace, patch) => {
            merged.push({ workspace, patch });
            return patch;
        },
        refreshUsageWindows: noWindowRefresh,
    });

    runtime.attach(session);
    session.emit("user.message", { agentId: "agent", timestamp: "2026-01-01T00:00:00.000Z" });
    session.emit("assistant.turn_start", { agentId: "agent", timestamp: "2026-01-01T00:00:00.000Z" });
    session.emit("assistant.turn_end", { agentId: "agent", timestamp: "2026-01-01T00:00:01.000Z" });
    await flushAsyncHandlers();

    assert.deepEqual(merged, []);
});

test("finalizeTurn skips empty or already completed turns", async () => {
    const session = new FakeSession();
    const deps = {
        mergeState: async () => {
            throw new Error("mergeState should not be called");
        },
    };

    assert.equal(await finalizeTurn(session, { events: 0, done: false }, {}, {}, deps), undefined);
    assert.equal(await finalizeTurn(session, { events: 1, done: true }, {}, {}, deps), undefined);
});

test("finalizeTurn checks the stale window sync gate before rendering the summary", async () => {
    const session = new FakeSession("/tmp/session-state/session-a");
    const calls = [];
    await finalizeTurn(session, {
        events: 1,
        startedAt: Date.UTC(2026, 0, 1),
        nanoAiu: 1_000_000_000,
    }, {}, {
        timestamp: "2026-01-01T00:00:02.000Z",
    }, {
        readState: async () => undefined,
        mergeState: async () => ({ totalUsd: 0.01 }),
        readSettings: async () => ({ mode: "message", unit: "usd", messageFormat: "{cost}" }),
        refreshUsageWindows: async () => ({}),
        renderSummary: () => {
            calls.push("message");
            return "summary";
        },
        runFirstRunTasks: async () => {
            calls.push("first-run");
        },
        claimUsageWindowSync: async ({ now, staleAfterMs }) => {
            calls.push(["claim", now, staleAfterMs]);
            return true;
        },
        now: () => 123,
        syncSessionLedger: async (context) => {
            calls.push(["sync", context]);
        },
    });

    assert.deepEqual(session.logs, ["summary"]);
    assert.deepEqual(calls, [
        ["claim", 123, 5 * 60 * 1000],
        ["sync", { currentSessionId: "session-a", now: 123 }],
        "message",
        "first-run",
    ]);
});

test("finalizeTurn still renders when a claimed stale window sync fails", async () => {
    const session = new FakeSession("/tmp/session-state/session-a");
    const calls = [];

    await finalizeTurn(session, {
        events: 1,
        startedAt: Date.UTC(2026, 0, 1),
        nanoAiu: 1_000_000_000,
    }, {}, {
        timestamp: "2026-01-01T00:00:02.000Z",
    }, {
        readState: async () => undefined,
        mergeState: async () => ({ totalUsd: 0.01 }),
        readSettings: async () => ({ mode: "message", unit: "usd", messageFormat: "{cost}" }),
        refreshUsageWindows: async () => ({ window24hUsd: 1 }),
        renderSummary: (state) => {
            calls.push(["message", state.window24hUsd]);
            return "summary after failed sync";
        },
        runFirstRunTasks: async () => {
            calls.push("first-run");
        },
        claimUsageWindowSync: async () => true,
        syncSessionLedger: async () => {
            calls.push("sync-failed");
            throw new Error("sync failed");
        },
    });

    assert.deepEqual(session.logs, ["summary after failed sync"]);
    assert.deepEqual(calls, [
        "sync-failed",
        ["message", 1],
        "first-run",
    ]);
});

test("finalizeTurn reconciles official usage from session RPC when available", async () => {
    const session = new FakeSession("/tmp/session-state/session-a");
    session.rpc = {
        usage: {
            getMetrics: async () => ({ totalNanoAiu: 2_000_000_000 }),
        },
    };
    let state;

    const result = await finalizeTurn(session, {
        events: 1,
        startedAt: Date.UTC(2026, 0, 1),
        nanoAiu: 1_000_000_000,
    }, {}, {
        timestamp: "2026-01-01T00:00:02.000Z",
    }, {
        readState: async () => state,
        mergeState: async (workspace, patch) => {
            state = { ...state, ...patch };
            return state;
        },
        readSettings: async () => ({ mode: "off", unit: "usd", messageFormat: "{cost}" }),
        runFirstRunTasks: noopFirstRun,
        claimUsageWindowSync: async () => false,
    });

    assert.equal(result.totalUsd, 0.02);
    assert.equal(result.pendingUsd, 0);
    assert.equal(result.officialTotalUsd, 0.02);
    assert.equal(result.sessionId, "session-a");
    assert.equal(result.window24hUsd, undefined);
});

test("syncCurrentSessionLedgerIfWindowsStale skips fresh windows and syncs claimed stale windows", async () => {
    const session = new FakeSession("/tmp/session-state/session-a");
    const calls = [];

    assert.equal(await syncCurrentSessionLedgerIfWindowsStale(session, {
        currentSessionId: () => "session-a",
        now: () => 100,
        windowSyncIntervalMs: 300_000,
        claimUsageWindowSync: async (context) => {
            calls.push(["fresh-claim", context]);
            return false;
        },
        syncSessionLedger: async () => {
            throw new Error("syncSessionLedger should not be called");
        },
    }), false);

    assert.equal(await syncCurrentSessionLedgerIfWindowsStale(session, {
        currentSessionId: () => "session-a",
        now: () => 200,
        windowSyncIntervalMs: 300_000,
        claimUsageWindowSync: async (context) => {
            calls.push(["stale-claim", context]);
            return true;
        },
        syncSessionLedger: async (context) => {
            calls.push(["sync", context]);
        },
    }), true);

    assert.deepEqual(calls, [
        ["fresh-claim", { now: 100, staleAfterMs: 300_000 }],
        ["stale-claim", { now: 200, staleAfterMs: 300_000 }],
        ["sync", { currentSessionId: "session-a", now: 200 }],
    ]);
});

test("syncCurrentSessionLedgerIfWindowsStale reports failed claimed syncs without throwing", async () => {
    const session = new FakeSession("/tmp/session-state/session-a");

    assert.equal(await syncCurrentSessionLedgerIfWindowsStale(session, {
        currentSessionId: () => "session-a",
        now: () => 300,
        windowSyncIntervalMs: 300_000,
        claimUsageWindowSync: async () => true,
        syncSessionLedger: async () => {
            throw new Error("sync failed");
        },
    }), false);
});

test("syncCurrentSessionLedgerIfWindowsStale reports failed stale-window claims without throwing", async () => {
    const session = new FakeSession("/tmp/session-state/session-a");

    assert.equal(await syncCurrentSessionLedgerIfWindowsStale(session, {
        currentSessionId: () => "session-a",
        now: () => 400,
        windowSyncIntervalMs: 300_000,
        claimUsageWindowSync: async () => {
            throw new Error("claim failed");
        },
        syncSessionLedger: async () => {
            throw new Error("syncSessionLedger should not be called");
        },
    }), false);
});

test("finalizeCompaction persists successful compaction usage only", async () => {
    const session = new FakeSession("/workspace");
    const merged = [];
    const firstRuns = [];
    const deps = {
        readState: async () => ({ officialTotalUsd: 1, pendingUsd: 0, totalUsd: 1 }),
        mergeState: async (workspace, patch) => {
            merged.push({ workspace, patch });
            return patch;
        },
        runFirstRunTasks: async (context) => {
            firstRuns.push(context);
        },
    };

    assert.equal(await finalizeCompaction(session, { success: false }, deps), undefined);
    const state = await finalizeCompaction(session, {
        success: true,
        compactionTokensUsed: { copilotUsage: { totalNanoAiu: 1_000_000_000 } },
        contextWindow: { currentTokens: 500, tokenLimit: 2000 },
    }, deps);

    assert.equal(merged.length, 1);
    assert.equal(merged[0].workspace, "/workspace");
    assert.equal(state.totalUsd, 1.01);
    assert.equal(state.pendingUsd, 0.01);
    assert.equal(state.contextTokens, 500);
    assert.equal(state.window24hUsd, undefined);
    assert.deepEqual(firstRuns, [{
        workspacePath: "/workspace",
        priorState: { officialTotalUsd: 1, pendingUsd: 0, totalUsd: 1 },
    }]);
});

class FakeSession {
    constructor(workspacePath = "/workspace") {
        this.workspacePath = workspacePath;
        this.handlers = new Map();
        this.logs = [];
    }

    on(name, handler) {
        this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
    }

    emit(name, event = {}) {
        for (const handler of this.handlers.get(name) ?? []) {
            handler(event);
        }
    }

    async log(value) {
        this.logs.push(value);
    }

    eventNames() {
        return [...this.handlers.keys()].sort();
    }
}

function usageEvent({ totalNanoAiu }) {
    return {
        timestamp: "2026-01-01T00:00:01.000Z",
        data: {
            inputTokens: 100,
            outputTokens: 10,
            cacheReadTokens: 20,
            cacheWriteTokens: 0,
            copilotUsage: { totalNanoAiu, tokenDetails: [] },
        },
    };
}

function flushAsyncHandlers() {
    return new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function noopFirstRun() {}

async function noWindowRefresh() {
    return {};
}
