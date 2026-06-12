import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exportSessionData } from "../../src/domain/session-export.mjs";

test("exports redacted JSONL session fixtures from local event files and ledger records", async () => {
    const root = await mkdtemp(join(tmpdir(), "private-local-path-copilot-cost-export-state-"));
    const outDir = await mkdtemp(join(tmpdir(), "copilot-cost-export-out-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-export-ledger-")), "session-ledger.json");
    const sessionDir = join(root, "session-a");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "events.jsonl"), [
        JSON.stringify({
            type: "assistant.usage",
            timestamp: "2026-06-10T10:00:00.000Z",
            data: {
                model: "gpt-test",
                inputTokens: 10,
                outputTokens: 5,
                copilotUsage: { totalNanoAiu: 100 },
                content: "do not export this",
            },
        }),
        JSON.stringify({
            type: "session.shutdown",
            timestamp: "2026-06-10T10:01:00.000Z",
            data: {
                totalNanoAiu: 500,
                modelMetrics: {
                    "gpt-test": {
                        totalNanoAiu: 500,
                        usage: { outputTokens: 7 },
                        requests: { count: 2, cost: 4 },
                    },
                },
            },
        }),
    ].join("\n"));
    await writeFile(ledgerPath, JSON.stringify({
        version: 1,
        sessions: {
            "session-a": {
                id: "session-a",
                state: "closed",
                source: "shutdown",
                totalNanoAiu: 500,
                lastSeenAt: Date.UTC(2026, 5, 10, 10, 1),
            },
            "ledger-only": {
                id: "ledger-only",
                state: "open",
                source: "statusline",
                totalNanoAiu: 123,
            },
        },
    }));

    const result = await exportSessionData({ sessionStateRoot: root, ledgerPath, cwd: outDir });
    const rows = (await readFile(result.outputPath, "utf8")).trim().split("\n").map(JSON.parse);

    assert.equal(result.sessionCount, 2);
    assert.equal(result.outputPath, join(outDir, "COPILOT_COST_DEBUG.jsonl"));
    assert.equal(rows.length, 2);
    assert.equal(JSON.stringify(rows).includes("do not export this"), false);
    assert.equal(JSON.stringify(rows).includes(root), false);

    const session = rows.find((row) => row.sessionId === "session-a");
    assert.equal(session.eventFile.path, "<session-state>/session-a/events.jsonl");
    assert.equal(session.events.parsedCount, 2);
    assert.deepEqual(session.events.typeCounts, { "assistant.usage": 1, "session.shutdown": 1 });
    assert.equal(session.extracted["assistant.usage"].copilotUsage.totalNanoAiuSum, 100);
    assert.equal(session.extracted["session.shutdown"].totalNanoAiuValues.at(-1), 500);
    assert.deepEqual(session.extracted["session.shutdown"].modelMetrics["gpt-test"].tokenTotals, {
        outputTokens: 7,
        requestCount: 2,
        requestCostUnits: 4,
    });
    assert.equal(session.extracted.summary.bestTotalNanoAiu, 500);
    assert.equal(session.ledgerSession.totalNanoAiu, 500);

    const ledgerOnly = rows.find((row) => row.sessionId === "ledger-only");
    assert.equal(ledgerOnly.eventFile, null);
    assert.equal(ledgerOnly.extracted, null);
    assert.equal(ledgerOnly.ledgerSession.totalNanoAiu, 123);
});
