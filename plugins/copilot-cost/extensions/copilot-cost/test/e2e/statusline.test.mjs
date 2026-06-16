import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { workspacePath } from "../../src/state.mjs";
import { sessionKey, sessionLedgerFilename, summaryStateFilename } from "../../src/storage.mjs";

test("resolves workspace path variants", () => {
    assert.equal(workspacePath({ workspace_path: "/tmp/work" }), "/tmp/work");
    assert.equal(workspacePath({ transcript_path: "/tmp/work/transcript.jsonl" }), "/tmp/work");
    assert.equal(workspacePath({ workspace_path: "/tmp/session-state", session_id: "abc" }), "/tmp/session-state/abc");
    assert.equal(workspacePath({ transcript_path: "/tmp/session-state/transcript.jsonl", session_id: "abc" }), "/tmp/session-state/abc");
});

test("statusline renders persisted summary state without writing live data", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "copilot-cost-work-"));
    await writeSummaryState(home, {
        runtime: {
            [sessionKey(workspace)]: {
                totalUsd: 0.12,
                sessionUsd: 0.1,
                contextTokens: 1200,
                contextTokenLimit: 200000,
            },
        },
        windows: { window24hUsd: 1, window7dUsd: 2, window30dUsd: 3 },
    });

    const result = runStatusline(home, {
        workspace_path: workspace,
        context_window: { current_context_tokens: 999999, displayed_context_limit: 999999 },
        ai_used: { total_nano_aiu: 9_000_000_000 },
    });

    assert.equal(result.status, 0);
    assert.match(clean(result.stdout), /Total \$0\.12 · Ctx 1% \(1k\/200k\) · Sess \$0\.1 · 24h \$1 · 7d \$2 · 30d \$3/);
    assert.equal(JSON.stringify(await summaryState(home)).includes("9000000000"), false);
    assert.equal(await exists(join(workspace, "copilot-cost-total.json")), false);
    assert.equal(await exists(sessionLedgerFile(home)), false);
});

test("statusline scopes reads to each session under a shared session-state root", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    const parent = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    const sessionRoot = join(parent, "session-state");
    await mkdir(sessionRoot, { recursive: true });
    await writeSummaryState(home, {
        runtime: {
            [sessionKey(join(sessionRoot, "first"))]: { totalUsd: 0.03, sessionUsd: 0.03 },
            [sessionKey(join(sessionRoot, "second"))]: { totalUsd: 0, sessionUsd: 0 },
        },
    });

    const first = runStatusline(home, payload(sessionRoot, "first"));
    const second = runStatusline(home, payload(sessionRoot, "second"));

    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    assert.match(clean(first.stdout), /Total \$0\.03/);
    assert.match(clean(second.stdout), /Total \$0\.00/);
    assert.equal((await summaryState(home)).liveSessions, undefined);
    assert.equal(await exists(sessionLedgerFile(home)), false);
});

test("statusline resumes an old session without contaminating new sessions", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    const parent = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    const sessionRoot = join(parent, "session-state");
    await mkdir(sessionRoot, { recursive: true });
    await writeSummaryState(home, {
        runtime: {
            [sessionKey(join(sessionRoot, "existing"))]: { totalUsd: 0.02, sessionUsd: 0.02 },
            [sessionKey(join(sessionRoot, "new"))]: { totalUsd: 0, sessionUsd: 0 },
        },
    });

    assert.equal(runStatusline(home, payload(sessionRoot, "existing")).status, 0);
    assert.equal(runStatusline(home, payload(sessionRoot, "new")).status, 0);
    assert.equal(runStatusline(home, payload(sessionRoot, "existing")).status, 0);

    assert.equal((await stateRecord(home, join(sessionRoot, "existing"))).totalUsd, 0.02);
    assert.equal((await stateRecord(home, join(sessionRoot, "new"))).totalUsd, 0);
});

test("statusline reads summary windows without recording official session usage", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "copilot-cost-work-"));
    await writeSummaryState(home, {
        runtime: {
            [sessionKey(workspace)]: { totalUsd: 0.02, sessionUsd: 0.02 },
        },
        windows: { window24hUsd: 1, window7dUsd: 2, window30dUsd: 3 },
    });

    const result = runStatusline(home, {
        workspace_path: workspace,
        session_id: "ledger-session",
        ai_used: { total_nano_aiu: 2_000_000_000 },
    });

    assert.equal(result.status, 0);
    assert.match(clean(result.stdout), /Total \$0\.02 .* Sess \$0\.0 · 24h \$1 · 7d \$2 · 30d \$3/);
    assert.equal((await summaryState(home)).liveSessions, undefined);
    assert.equal(await exists(sessionLedgerFile(home)), false);
});

test("statusline does not reconcile official catch-up from stdin", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "copilot-cost-work-"));
    await mkdir(pluginDataDir(home), { recursive: true });
    await writeFile(settingsFile(home), JSON.stringify({
        mode: "footer",
        unit: "usd",
        footerFormat: "{total_group}",
    }));
    await writeSummaryRuntimeState(home, workspace, {
        totalUsd: 0.03,
        pendingUsd: 0.03,
    });

    const result = runStatusline(home, {
        workspace_path: workspace,
        session_id: "catch-up",
        ai_used: { total_nano_aiu: 84_200_000_000 },
    });

    assert.equal(result.status, 0);
    assert.match(clean(result.stdout), /Total \$0\.03/);
    const state = await stateRecord(home, workspace);
    assert.equal(state.sessionUsd, undefined);
    assertNear(state.totalUsd, 0.03);
    assert.equal(state.pendingUsd, 0.03);
});

function payload(sessionRoot, sessionId) {
    return {
        workspace_path: sessionRoot,
        session_id: sessionId,
        context_window: {},
        ai_used: { total_nano_aiu: 99_000_000_000 },
    };
}

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
    return join(pluginDataDir(home), sessionLedgerFilename());
}

function summaryStateFile(home) {
    return join(pluginDataDir(home), summaryStateFilename());
}

async function stateRecord(home, workspace) {
    return (await summaryState(home)).runtime[sessionKey(workspace)];
}

async function writeSummaryRuntimeState(home, workspace, state) {
    return writeSummaryState(home, {
        runtime: {
            [sessionKey(workspace)]: state,
        },
    });
}

async function writeSummaryState(home, state) {
    await mkdir(pluginDataDir(home), { recursive: true });
    await writeFile(settingsFile(home), JSON.stringify({ mode: "footer", unit: "usd" }));
    await writeFile(summaryStateFile(home), JSON.stringify({
        version: 1,
        ...state,
    }));
}

async function summaryState(home) {
    return JSON.parse(await readFile(summaryStateFile(home), "utf8"));
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

function clean(value) {
    return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function assertNear(actual, expected) {
    assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} not near ${expected}`);
}
