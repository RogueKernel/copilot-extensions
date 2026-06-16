import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { summaryStatePath } from "../../src/storage.mjs";
import { mergeState, readState, stateKey, workspacePath } from "../../src/state.mjs";

test("state key is derived from the workspace path", async () => {
    await withCopilotHome(async () => {
        const workspace = await mkdtemp(join(tmpdir(), "copilot-cost-state-"));

        assert.match(stateKey(workspace), /^copilot-cost-state-/);
        assert.match(stateKey(workspace), /-[0-9a-f]{12}$/);
    });
});

test("readState returns undefined when no workspace or state file exists", async () => {
    await withCopilotHome(async () => {
        const workspace = await mkdtemp(join(tmpdir(), "copilot-cost-state-"));

        assert.equal(await readState(), undefined);
        assert.equal(await readState(workspace), undefined);
    });
});

test("mergeState applies patches and persists current state", async () => {
    await withCopilotHome(async () => {
        const workspace = await mkdtemp(join(tmpdir(), "copilot-cost-state-"));
        await writeSummaryState({ [stateKey(workspace)]: { totalUsd: 1, pendingUsd: 0.25 } });

        const state = await mergeState(workspace, { pendingUsd: 0, lastUsd: 0.02, window24hUsd: 1 });

        assert.deepEqual(state, { totalUsd: 1, pendingUsd: 0, lastUsd: 0.02, window24hUsd: 1 });
        assert.deepEqual(await readState(workspace), { totalUsd: 1, pendingUsd: 0, lastUsd: 0.02 });
    });
});

test("mergeState deletes null patch values", async () => {
    await withCopilotHome(async () => {
        const workspace = await mkdtemp(join(tmpdir(), "copilot-cost-state-"));
        await writeSummaryState({ [stateKey(workspace)]: { totalUsd: 1, pendingUsd: 0.25 } });

        const state = await mergeState(workspace, { pendingUsd: null, lastUsd: 0.02 });

        assert.deepEqual(state, { totalUsd: 1, lastUsd: 0.02 });
        assert.deepEqual(await readState(workspace), state);
    });
});

test("mergeState can merge patches before a workspace is known", async () => {
    assert.deepEqual(await mergeState(undefined, { contextTokens: 1200 }), { contextTokens: 1200 });
});

async function withCopilotHome(callback) {
    const prior = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    try {
        return await callback();
    } finally {
        if (prior === undefined) {
            delete process.env.COPILOT_HOME;
        } else {
            process.env.COPILOT_HOME = prior;
        }
    }
}

async function writeSummaryState(runtime) {
    await mkdir(dirname(summaryStatePath()), { recursive: true });
    await writeFile(summaryStatePath(), JSON.stringify({ version: 1, runtime }));
}

test("workspacePath normalizes statusline workspace variants", () => {
    assert.equal(workspacePath({ workspacePath: "/tmp/work" }), "/tmp/work");
    assert.equal(workspacePath({ session_workspace_path: "/tmp/work" }), "/tmp/work");
    assert.equal(workspacePath({ transcriptPath: "/tmp/work/transcript.jsonl" }), "/tmp/work");
    assert.equal(workspacePath({ workspace_path: "/tmp/session-state", session_id: "abc" }), "/tmp/session-state/abc");
    const expectedHome = process.env.COPILOT_HOME || join(homedir(), ".copilot");
    assert.equal(workspacePath({ session_id: "abc" }), join(expectedHome, "session-state", "abc"));
    assert.equal(workspacePath({ workspace_path: "   ", transcript_path: "" }), undefined);
});
