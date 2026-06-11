import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { workspacePath } from "../../src/state.mjs";
import { sessionKey } from "../../src/storage.mjs";

test("resolves workspace path variants", () => {
    assert.equal(workspacePath({ workspace_path: "/tmp/work" }), "/tmp/work");
    assert.equal(workspacePath({ transcript_path: "/tmp/work/transcript.jsonl" }), "/tmp/work");
    assert.equal(workspacePath({ workspace_path: "/tmp/session-state", session_id: "abc" }), "/tmp/session-state/abc");
    assert.equal(workspacePath({ transcript_path: "/tmp/session-state/transcript.jsonl", session_id: "abc" }), "/tmp/session-state/abc");
});

test("statusline process renders and persists state", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "copilot-cost-work-"));
    const payload = {
        workspace_path: workspace,
        context_window: { current_context_tokens: 1200, displayed_context_limit: 200000 },
        ai_used: { total_nano_aiu: 0 },
    };

    const result = spawnSync(process.execPath, ["extension.mjs", "--statusline"], {
        cwd: new URL("../..", import.meta.url),
        env: envFor(home),
        input: JSON.stringify(payload),
        encoding: "utf8",
    });

    assert.equal(result.status, 0);
    const stdout = result.stdout.replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(stdout, /£0\.00/);
    assert.match(stdout, /^\u00a0Total £0\.00 · Ctx 1% \(1k\/200k\) · Sess £0\.0 · 24h £0 · 7d £0 · 30d £0/);

    const state = await stateRecord(home, workspace);
    assert.equal(state.sessionUsd, 0);
    assert.equal(state.contextTokens, 1200);
    assert.equal(state.contextTokenLimit, 200000);
    assert.equal(await exists(join(workspace, "copilot-cost-total.json")), false);
});

test("statusline scopes totals to each session under a shared session-state root", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    const parent = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    const sessionRoot = join(parent, "session-state");
    await mkdir(sessionRoot, { recursive: true });
    const payload = (sessionId, totalNanoAiu) => ({
        workspace_path: sessionRoot,
        session_id: sessionId,
        context_window: {},
        ai_used: { total_nano_aiu: totalNanoAiu },
    });

    const first = runStatusline(home, payload("first", 3_000_000_000));
    const second = runStatusline(home, payload("second", 0));

    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    assert.equal(await exists(join(sessionRoot, "copilot-cost-total.json")), false);

    const firstState = await stateRecord(home, join(sessionRoot, "first"));
    const secondState = await stateRecord(home, join(sessionRoot, "second"));
    const ledger = JSON.parse(await readFile(sessionLedgerFile(home), "utf8"));
    assert.equal(firstState.sessionUsd, 0.03);
    assert.equal(secondState.sessionUsd, 0);
    assert.equal(firstState.totalUsd, 0.03);
    assert.equal(secondState.totalUsd, 0);
    assert.equal(ledger.sessions.first.totalNanoAiu, 3_000_000_000);
    assert.equal(ledger.sessions.second.totalNanoAiu, 0);
});

test("statusline resumes an old session without contaminating new sessions", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    const parent = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    const sessionRoot = join(parent, "session-state");
    await mkdir(sessionRoot, { recursive: true });
    const payload = (sessionId, totalNanoAiu) => ({
        workspace_path: sessionRoot,
        session_id: sessionId,
        context_window: {},
        ai_used: { total_nano_aiu: totalNanoAiu },
    });

    assert.equal(runStatusline(home, payload("existing", 1_000_000_000)).status, 0);
    assert.equal(runStatusline(home, payload("new", 0)).status, 0);
    assert.equal(runStatusline(home, payload("existing", 2_000_000_000)).status, 0);

    const existingState = await stateRecord(home, join(sessionRoot, "existing"));
    const newState = await stateRecord(home, join(sessionRoot, "new"));
    assert.equal(existingState.sessionUsd, 0.02);
    assert.equal(newState.sessionUsd, 0);
    assert.equal(existingState.totalUsd, 0.02);
    assert.equal(newState.totalUsd, 0);
});

test("statusline reconciles official session usage into Total and ledger windows", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "copilot-cost-work-"));
    const payload = (totalNanoAiu) => ({
        workspace_path: workspace,
        session_id: "ledger-session",
        context_window: {},
        ai_used: { total_nano_aiu: totalNanoAiu },
    });
    const runStatusline = (totalNanoAiu) => spawnSync(process.execPath, ["extension.mjs", "--statusline"], {
        cwd: new URL("../..", import.meta.url),
        env: envFor(home),
        input: JSON.stringify(payload(totalNanoAiu)),
        encoding: "utf8",
    });
    const first = runStatusline(1_000_000_000);
    assert.equal(first.status, 0);
    // Regression guard: ai_used.total_nano_aiu must reconcile Total, not render
    // as a Sess-only value, because local assistant.usage can miss tool work.
    assert.match(first.stdout.replace(/\x1b\[[0-9;]*m/g, ""), /Total £0\.01 .* Sess £0\.0 · 24h £0 · 7d £0 · 30d £0/);
    const second = runStatusline(2_000_000_000);
    assert.equal(second.status, 0);

    const state = await stateRecord(home, workspace);
    assert.equal(state.sessionUsd, 0.02);
    assert.equal(state.totalUsd, 0.02);
    const ledger = JSON.parse(await readFile(sessionLedgerFile(home), "utf8"));
    assert.equal(ledger.sessions["ledger-session"].totalNanoAiu, 2_000_000_000);
    assert.equal(await exists(sessionLedgerFile(home)), true);
});

test("statusline official catch-up replaces lower locally observed total", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "copilot-cost-work-"));
    await mkdir(pluginDataDir(home), { recursive: true });
    await writeFile(settingsFile(home), JSON.stringify({
        mode: "footer",
        unit: "usd",
        footerFormat: "{total_group}",
    }));
    await writeRuntimeState(home, workspace, {
        totalUsd: 0.03,
        pendingUsd: 0.03,
    });

    const result = runStatusline(home, {
        workspace_path: workspace,
        session_id: "catch-up",
        context_window: {},
        ai_used: { total_nano_aiu: 84_200_000_000 },
    });

    assert.equal(result.status, 0);
    // This reproduces the £0.03-vs-84.2-credits bug: official catch-up must win.
    assert.match(result.stdout.replace(/\x1b\[[0-9;]*m/g, ""), /Total \$0\.84/);

    const state = await stateRecord(home, workspace);
    assertNear(state.sessionUsd, 0.842);
    assertNear(state.totalUsd, 0.842);
    assert.equal(state.pendingUsd, 0);
});

function runStatusline(home, payload) {
    return spawnSync(process.execPath, ["extension.mjs", "--statusline"], {
        cwd: new URL("../..", import.meta.url),
        env: envFor(home),
        input: JSON.stringify(payload),
        encoding: "utf8",
    });
}

function envFor(home) {
    return { ...process.env, COPILOT_PLUGIN_DATA: pluginDataDir(home), HOME: home };
}

function pluginDataDir(home) {
    return join(home, ".copilot", "plugin-data", "copilot-extensions", "copilot-cost");
}

function settingsFile(home) {
    return join(pluginDataDir(home), "settings.json");
}

function sessionLedgerFile(home) {
    return join(pluginDataDir(home), "session-ledger.json");
}

async function stateRecord(home, workspace) {
    const ledger = JSON.parse(await readFile(sessionLedgerFile(home), "utf8"));
    return ledger.runtime[sessionKey(workspace)];
}

async function writeRuntimeState(home, workspace, state) {
    await mkdir(pluginDataDir(home), { recursive: true });
    await writeFile(sessionLedgerFile(home), JSON.stringify({
        version: 1,
        sessions: {},
        runtime: {
            [sessionKey(workspace)]: state,
        },
    }));
}

async function exists(path) {
    try {
        await readFile(path);
        return true;
    } catch (error) {
        if (error?.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}

function assertNear(actual, expected) {
    assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} not near ${expected}`);
}
