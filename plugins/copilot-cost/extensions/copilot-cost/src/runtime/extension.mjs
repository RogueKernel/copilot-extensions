// Extension-host runtime for normal Copilot CLI sessions.
// The @github/copilot-sdk import stays inside runExtension(); the rest of this module is a
// testable runtime seam for command registration, event wiring, and finalizers.

import { officialTotal, snapshotCompaction, snapshotTurn } from "../domain/cost.mjs";
import { closeFromShutdown, updateSessionLedger } from "../domain/session-ledger.mjs";
import { modelMetricsFromShutdown } from "../domain/session-jsonl.mjs";
import { currentSessionId, syncSessionLedger } from "../domain/session-sync.mjs";
import { collect, createTurn } from "../domain/turns.mjs";
import { refreshUsageWindows } from "../domain/windows.mjs";
import { optNum } from "../math.mjs";
import { renderSummary } from "../render/summary.mjs";
import { timestampMs } from "../render/format.mjs";
import { configure, readSettings, displays } from "../settings.mjs";
import { runFirstRunTasks } from "../first-run.mjs";
import { mergeState, readState } from "../state.mjs";

const DEFAULT_RUNTIME_DEPS = {
    collect,
    configure,
    createTurn,
    displays,
    mergeState,
    now: () => Date.now(),
    optNum,
    readSettings,
    readState,
    refreshUsageWindows,
    renderSummary,
    runFirstRunTasks,
    syncSessionLedger,
    currentSessionId,
    closeFromShutdown,
    officialTotal,
    snapshotCompaction,
    snapshotTurn,
    timestampMs,
    updateSessionLedger,
};

// Joins the Copilot CLI session and wires usage events to cost-state patches.
export async function runExtension({
    importSdk = () => import("@github/copilot-sdk/extension"),
} = {}) {
    const { joinSession } = await importSdk();
    const runtime = createSessionRuntime();
    const session = await joinSession(runtime.joinOptions());
    runtime.attach(session);
}

// Builds the normal-session runtime without loading the SDK package.
// Tests use this seam with fake sessions and in-memory adapters.
export function createSessionRuntime(overrides = {}) {
    const deps = { ...DEFAULT_RUNTIME_DEPS, ...overrides };
    let session;
    let turn = deps.createTurn();
    let contextWindow = {};
    const commands = [{
        name: "cost",
        description: "Show cost overview and settings",
        handler: (context) => deps.configure(session, context),
    }];

    return {
        joinOptions: () => ({ tools: [], commands }),
        attach(nextSession) {
            session = nextSession;
            wireSessionEvents(session, {
                deps,
                getTurn: () => turn,
                setTurn: (nextTurn) => {
                    turn = nextTurn;
                },
                getContextWindow: () => contextWindow,
                setContextWindow: (nextContextWindow) => {
                    contextWindow = nextContextWindow;
                },
            });
            const id = deps.currentSessionId(session);
            if (id) {
                void deps.syncSessionLedger({ currentSessionId: id });
            }
            return session;
        },
    };
}

function wireSessionEvents(session, runtime) {
    const { deps } = runtime;
    const finalizeCurrentTurn = (event) => void finalizeTurn(
        session,
        runtime.getTurn(),
        runtime.getContextWindow(),
        event,
        deps,
    );
    const finalizeCurrentCompaction = (event) => void finalizeCompaction(session, event.data, deps);
    const finalizeCurrentShutdown = (event) => void finalizeShutdown(session, event, deps);

    session.on("user.message", (event) => {
        if (isAgentEvent(event)) {
            return;
        }
        let turn = runtime.getTurn();
        if (turn.done) {
            turn = deps.createTurn();
            runtime.setTurn(turn);
        }
        turn.startedAt ??= deps.timestampMs(event.timestamp) ?? deps.now();
        void rememberOfficialStart(session, turn, deps);
    });

    session.on("assistant.turn_start", (event) => {
        if (isAgentEvent(event)) {
            return;
        }
        let turn = runtime.getTurn();
        if (turn.done) {
            turn = deps.createTurn();
            runtime.setTurn(turn);
        }
        turn.startedAt ??= deps.timestampMs(event.timestamp) ?? deps.now();
        turn.turnId ??= event.data?.turnId;
        void rememberOfficialStart(session, turn, deps);
    });

    session.on("assistant.usage", (event) => {
        let turn = runtime.getTurn();
        if (turn.done) {
            turn = deps.createTurn();
            runtime.setTurn(turn);
            void rememberOfficialStart(session, turn, deps);
        }
        deps.collect(turn, event);
    });

    session.on("session.usage_info", (event) => {
        if (isAgentEvent(event)) {
            return;
        }
        runtime.setContextWindow(nextContextWindow(runtime.getContextWindow(), event, deps.optNum));
    });

    session.on("session.idle", finalizeCurrentTurn);
    session.on("session.compaction_complete", finalizeCurrentCompaction);
    session.on("session.shutdown", finalizeCurrentShutdown);
}

// Persists one completed turn and logs the after-message summary when enabled.
export async function finalizeTurn(session, turn, contextWindow, completionEvent, overrides = {}) {
    const deps = { ...DEFAULT_RUNTIME_DEPS, ...overrides };
    if (turn.done || turn.events === 0) {
        return undefined;
    }
    turn.done = true;
    turn.endedAt = deps.timestampMs(completionEvent?.timestamp) ?? deps.now();
    await resolveOfficialStart(turn);
    const priorState = await deps.readState(session.workspacePath);
    const patch = deps.snapshotTurn(turn, priorState, contextWindow);
    const state = await deps.mergeState(session.workspacePath, patch);
    const settings = await deps.readSettings();
    if (deps.displays(settings.mode, "message")) {
        const windows = await deps.refreshUsageWindows();
        await session.log(renderMessageSummary(state, windows, settings, deps));
    }
    await deps.runFirstRunTasks({ workspacePath: session.workspacePath, priorState });
    return state;
}

// Persists compaction usage, which arrives outside the normal turn lifecycle.
export async function finalizeCompaction(session, compaction, overrides = {}) {
    const deps = { ...DEFAULT_RUNTIME_DEPS, ...overrides };
    if (!compaction?.success || !compaction.compactionTokensUsed) {
        return undefined;
    }

    const priorState = await deps.readState(session.workspacePath);
    const patch = deps.snapshotCompaction(compaction, priorState);
    const state = await deps.mergeState(session.workspacePath, patch);
    await deps.runFirstRunTasks({ workspacePath: session.workspacePath, priorState });
    return state;
}

// Best-effort shutdown closure; startup scans/statusline live totals remain the durable fallback.
export async function finalizeShutdown(session, event, overrides = {}) {
    const deps = { ...DEFAULT_RUNTIME_DEPS, ...overrides };
    const id = deps.currentSessionId(session);
    if (!id) {
        return undefined;
    }

    const data = event?.data ?? {};
    const at = deps.timestampMs(event?.timestamp) ?? deps.now();
    const ledger = await deps.updateSessionLedger((prior) => deps.closeFromShutdown(prior, {
        id,
        totalNanoAiu: deps.optNum(data.totalNanoAiu),
        modelNanoAiu: modelNanoAiu(data.modelMetrics, deps.optNum),
        modelMetrics: modelMetricsFromShutdown(data.modelMetrics),
        at,
    }));
    return ledger.sessions[id];
}

// Merges new context-window sizes over the prior ones, preserving known values.
function nextContextWindow(priorContextWindow, event, optNumFn) {
    return {
        currentTokens: optNumFn(event.data?.currentTokens) ?? priorContextWindow.currentTokens,
        tokenLimit: optNumFn(event.data?.tokenLimit) ?? priorContextWindow.tokenLimit,
    };
}

function renderMessageSummary(state, windows, settings, deps) {
    const summaryOptions = {
        color: true,
        unit: settings.unit,
        format: settings.messageFormat,
    };
    return deps.renderSummary({ ...state, ...windows }, summaryOptions);
}

function rememberOfficialStart(session, turn, deps) {
    if (turn.officialStartedUsd !== undefined || turn.officialStartPromise) {
        return;
    }
    // Paired with snapshotTurn(): prevents counting usage that became official
    // while this turn was in flight as both official and pending.
    turn.officialStartPromise = deps.readState(session.workspacePath).then((state) => {
        turn.officialStartedUsd = deps.officialTotal(state);
    }, (error) => {
        turn.officialStartError = error;
    });
}

async function resolveOfficialStart(turn) {
    await turn.officialStartPromise;
    turn.officialStartPromise = undefined;
    if (turn.officialStartError) {
        const error = turn.officialStartError;
        turn.officialStartError = undefined;
        throw error;
    }
}

// Sub-agent events carry an agentId; the main session's own turns do not.
function isAgentEvent(event) {
    return Boolean(event?.agentId);
}

function modelNanoAiu(modelMetrics = {}, optNumFn) {
    if (!modelMetrics || typeof modelMetrics !== "object") {
        return undefined;
    }
    const total = Object.values(modelMetrics)
        .map((metrics) => optNumFn(metrics?.totalNanoAiu))
        .filter((value) => value !== undefined)
        .reduce((sum, value) => sum + value, 0);
    return total > 0 ? total : undefined;
}
