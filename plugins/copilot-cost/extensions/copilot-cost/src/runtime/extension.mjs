// Extension-host runtime for normal Copilot CLI sessions.
// The @github/copilot-sdk import stays inside runExtension(); the rest of this module is a
// testable runtime seam for command registration, event wiring, and finalizers.

import { officialTotal, snapshotCompaction, snapshotStatus, snapshotTurn } from "../domain/cost.mjs";
import { currentSessionId, syncSessionLedger } from "../domain/session-sync.mjs";
import { collect, createTurn } from "../domain/turns.mjs";
import { refreshUsageWindows } from "../domain/windows.mjs";
import { optNum } from "../math.mjs";
import { renderSummary } from "../render/summary.mjs";
import { timestampMs } from "../render/format.mjs";
import { configure, readSettings, displays } from "../settings.mjs";
import { resetLedgerOnVersionChange, runFirstRunTasks, runStartupTasks } from "../first-run.mjs";
import { mergeState, readState } from "../state.mjs";
import { claimUsageWindowSync } from "../summary-state.mjs";
import { installCostDebugProbe } from "./usage-debug.mjs";

const WINDOW_SYNC_INTERVAL_MS = 5 * 60 * 1000;

const DEFAULT_RUNTIME_DEPS = {
    claimUsageWindowSync,
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
    resetLedgerOnVersionChange,
    runFirstRunTasks,
    syncSessionLedger,
    windowSyncIntervalMs: WINDOW_SYNC_INTERVAL_MS,
    currentSessionId,
    officialTotal,
    snapshotCompaction,
    snapshotStatus,
    snapshotTurn,
    timestampMs,
    installCostDebugProbe,
};

// Joins the Copilot CLI session and wires usage events to cost-state patches.
export async function runExtension({
    importSdk = () => import("@github/copilot-sdk/extension"),
    startupTasks = runStartupTasks,
} = {}) {
    const { joinSession } = await importSdk();
    const runtime = createSessionRuntime({ runStartupTasks: startupTasks });
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
            const startupReady = Promise.resolve(deps.runStartupTasks
                ? deps.runStartupTasks()
                : deps.resetLedgerOnVersionChange?.());
            wireSessionEvents(session, {
                deps,
                startupReady,
                getTurn: () => turn,
                setTurn: (nextTurn) => {
                    turn = nextTurn;
                },
                getContextWindow: () => contextWindow,
                setContextWindow: (nextContextWindow) => {
                    contextWindow = nextContextWindow;
                },
            });
            deps.installCostDebugProbe?.(session);
            void startupReady.finally(() => syncCurrentSessionLedger(session, deps)).catch(() => {});
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
        rememberOfficialStart(session, turn, deps, runtime.startupReady);
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
        rememberOfficialStart(session, turn, deps, runtime.startupReady);
    });

    session.on("assistant.usage", (event) => {
        let turn = runtime.getTurn();
        if (turn.done) {
            turn = deps.createTurn();
            runtime.setTurn(turn);
            rememberOfficialStart(session, turn, deps, runtime.startupReady);
        }
        deps.collect(turn, event);
    });

    session.on("session.usage_info", (event) => {
        if (isAgentEvent(event)) {
            return;
        }
        const contextWindow = nextContextWindow(runtime.getContextWindow(), event, deps.optNum);
        runtime.setContextWindow(contextWindow);
        void runtime.startupReady.then(() => refreshOfficialUsageMetrics(session, deps, contextPatch(contextWindow)));
    });

    session.on("session.idle", (event) => void runtime.startupReady.then(() => finalizeCurrentTurn(event)));
    session.on("session.compaction_complete", (event) => void runtime.startupReady.then(() => finalizeCurrentCompaction(event)));
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
    let state = await deps.mergeState(session.workspacePath, patch);
    state = await refreshOfficialUsageMetrics(session, deps) ?? state;
    await syncCurrentSessionLedgerIfWindowsStale(session, deps);
    const settings = await deps.readSettings();
    if (deps.displays(settings.mode, "message")) {
        const windows = await deps.refreshUsageWindows();
        await session.log(renderMessageSummary(state, windows, settings, deps));
    }
    await deps.runFirstRunTasks({ workspacePath: session.workspacePath, priorState });
    return state;
}

export function syncCurrentSessionLedger(session, deps = DEFAULT_RUNTIME_DEPS) {
    const id = deps.currentSessionId(session);
    if (!id) {
        return undefined;
    }
    return deps.syncSessionLedger({ currentSessionId: id });
}

// Persists compaction usage, which arrives outside the normal turn lifecycle.
export async function finalizeCompaction(session, compaction, overrides = {}) {
    const deps = { ...DEFAULT_RUNTIME_DEPS, ...overrides };
    if (!compaction?.success || !compaction.compactionTokensUsed) {
        return undefined;
    }

    const priorState = await deps.readState(session.workspacePath);
    const patch = deps.snapshotCompaction(compaction, priorState);
    let state = await deps.mergeState(session.workspacePath, patch);
    state = await refreshOfficialUsageMetrics(session, deps) ?? state;
    await syncCurrentSessionLedgerIfWindowsStale(session, deps);
    await deps.runFirstRunTasks({ workspacePath: session.workspacePath, priorState });
    return state;
}

export async function syncCurrentSessionLedgerIfWindowsStale(session, deps = DEFAULT_RUNTIME_DEPS) {
    const id = deps.currentSessionId(session);
    if (!id) {
        return false;
    }
    const now = deps.now();
    try {
        const claimed = await deps.claimUsageWindowSync({
            now,
            staleAfterMs: deps.windowSyncIntervalMs,
        });
        if (!claimed) {
            return false;
        }
        await deps.syncSessionLedger({ currentSessionId: id, now });
        return true;
    } catch {
        return false;
    }
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

async function refreshOfficialUsageMetrics(session, deps, extraPatch = {}) {
    const getMetrics = session?.rpc?.usage?.getMetrics;
    const id = deps.currentSessionId(session);
    const sessionPatch = id ? { sessionId: id, ...extraPatch } : extraPatch;
    if (typeof getMetrics !== "function") {
        return hasPatchValues(sessionPatch) ? deps.mergeState(session.workspacePath, sessionPatch) : undefined;
    }
    if (!id) {
        return hasPatchValues(extraPatch) ? deps.mergeState(session.workspacePath, extraPatch) : undefined;
    }

    try {
        const metrics = await getMetrics.call(session.rpc.usage);
        const totalNanoAiu = deps.optNum(metrics?.totalNanoAiu);
        if (totalNanoAiu === undefined) {
            return hasPatchValues(sessionPatch) ? deps.mergeState(session.workspacePath, sessionPatch) : undefined;
        }
        const priorState = await deps.readState(session.workspacePath);
        return deps.mergeState(session.workspacePath, {
            ...deps.snapshotStatus({ ai_used: { total_nano_aiu: totalNanoAiu } }, priorState),
            ...sessionPatch,
        });
    } catch {
        return hasPatchValues(sessionPatch) ? deps.mergeState(session.workspacePath, sessionPatch) : undefined;
    }
}

function contextPatch(contextWindow = {}) {
    return {
        contextTokens: contextWindow.currentTokens,
        contextTokenLimit: contextWindow.tokenLimit,
    };
}

function hasPatchValues(patch = {}) {
    return Object.values(patch).some((value) => value !== undefined);
}

function rememberOfficialStart(session, turn, deps, startupReady = Promise.resolve()) {
    if (turn.officialStartedUsd !== undefined || turn.officialStartPromise) {
        return;
    }
    // Paired with snapshotTurn(): prevents counting usage that became official
    // while this turn was in flight as both official and pending.
    turn.officialStartPromise = Promise.resolve(startupReady).then(() => deps.readState(session.workspacePath)).then((state) => {
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
