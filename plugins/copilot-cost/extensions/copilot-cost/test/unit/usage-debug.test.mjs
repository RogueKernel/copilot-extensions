import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { installCostDebugProbe } from "../../src/runtime/usage-debug.mjs";

test("debug probe records event shape and usage metrics without content", async () => {
    const outputPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-debug-")), "debug-events.jsonl");
    const session = new FakeSession();

    assert.equal(installCostDebugProbe(session, { enabled: true, outputPath }), true);
    session.emit("assistant.usage", {
        timestamp: "2026-06-10T12:00:00.000Z",
        data: {
            content: "do not persist",
            inputTokens: 100,
            copilotUsage: { totalNanoAiu: 1_000_000_000 },
        },
    });
    const records = await readDebugRecords(outputPath);

    assert.equal(records[0].name, "assistant.usage");
    assert.deepEqual(records[0].dataKeys, ["content", "copilotUsage", "inputTokens"]);
    assert.equal(records[0].data.inputTokens, 100);
    assert.equal(records[0].data.copilotUsage.totalNanoAiu, 1_000_000_000);
    assert.equal(JSON.stringify(records).includes("do not persist"), false);
});

class FakeSession {
    constructor() {
        this.handlers = new Map();
    }

    on(name, handler) {
        this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
    }

    emit(name, event = {}) {
        for (const handler of this.handlers.get(name) ?? []) {
            handler(event);
        }
    }
}

async function readDebugRecords(path) {
    for (let index = 0; index < 50; index += 1) {
        await sleep(10);
        try {
            return (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
        } catch (error) {
            if (error?.code !== "ENOENT") {
                throw error;
            }
        }
    }
    return JSON.parse(await readFile(path, "utf8"));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
