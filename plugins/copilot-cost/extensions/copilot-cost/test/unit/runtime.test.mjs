import test from "node:test";
import assert from "node:assert/strict";

import {
    createSessionRuntime,
    finalizeCompaction,
    finalizeShutdown,
    finalizeTurn,
    runExtension,
} from "../../src/runtime/extension.mjs";

test("runExtension registers /cost and attaches session handlers", async () => {
    const session = new FakeSession();
    let joinOptions;

    await runExtension({
        importSdk: async () => ({
            joinSession: async (options) => {
                joinOptions = options;
                return session;
            },
        }),
    });

    assert.equal(joinOptions.commands[0].name, "cost");
    assert.deepEqual(session.eventNames(), [
        "assistant.turn_start",
        "assistant.usage",
        "session.compaction_complete",
        "session.idle",
        "session.shutdown",
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

test("createSessionRuntime starts ledger sync when the session id is known", () => {
    const session = new FakeSession("/tmp/session-state/session-a");
    const calls = [];
    const runtime = createSessionRuntime({
        syncSessionLedger: async (context) => calls.push(context),
    });

    runtime.attach(session);

    assert.deepEqual(calls, [{ currentSessionId: "session-a" }]);
});

test("session runtime persists one user turn and logs message output", async () => {
    const session = new FakeSession("/workspace");
    const merged = [];
    const runtime = createSessionRuntime({
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

    assert.equal(merged.length, 1);
    assert.equal(merged[0].workspace, "/workspace");
    assert.equal(merged[0].patch.lastUsd, 0.02);
    assert.equal(merged[0].patch.contextTokens, 1200);
    assert.equal(merged[0].patch.contextTokenLimit, 200000);
    assert.equal(merged[0].patch.window24hUsd, undefined);
    assert.deepEqual(session.logs, ["summary 1.02"]);

    session.emit("session.idle", { timestamp: "2026-01-01T00:00:03.000Z" });
    await flushAsyncHandlers();
    assert.equal(merged.length, 1);
});

test("session runtime waits for session idle before logging message output", async () => {
    const session = new FakeSession("/workspace");
    const merged = [];
    const firstRuns = [];
    const runtime = createSessionRuntime({
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

test("finalizeShutdown marks the session ledger closed when shutdown data arrives", async () => {
    let written;
    const record = await finalizeShutdown(new FakeSession("/tmp/session-state/abc"), {
        timestamp: "2026-01-01T00:00:00.000Z",
        data: {
            modelMetrics: {
                "gpt-test": { totalNanoAiu: 2_000_000_000 },
            },
        },
    }, {
        updateSessionLedger: async (updater) => {
            const ledger = await updater({});
            written = ledger;
            return ledger;
        },
    });

    assert.equal(record.state, "closed");
    assert.equal(record.totalNanoAiu, 2_000_000_000);
    assert.equal(record.source, "modelMetrics");
    assert.equal(written.sessions.abc.totalNanoAiu, 2_000_000_000);
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

async function noopFirstRun() {}

async function noWindowRefresh() {
    return {};
}
