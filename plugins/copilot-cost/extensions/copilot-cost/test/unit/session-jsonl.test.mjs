import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseSessionEvents } from "../../src/domain/session-jsonl.mjs";

test("extracts shutdown AIU, model fallback, compaction, and tokens without content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "copilot-cost-jsonl-"));
    const file = join(dir, "events.jsonl");
    await writeFile(file, [
        JSON.stringify({
            type: "assistant.usage",
            timestamp: "2026-06-10T10:00:00.000Z",
            data: {
                model: "gpt-test",
                inputTokens: 10,
                outputTokens: 5,
                copilotUsage: { totalNanoAiu: 100 },
                content: "do not persist this prompt",
            },
        }),
        JSON.stringify({
            type: "session.compaction_complete",
            timestamp: "2026-06-10T10:05:00.000Z",
            data: {
                compactionTokensUsed: {
                    inputTokens: 20,
                    cacheReadTokens: 7,
                    copilotUsage: { totalNanoAiu: 200 },
                },
            },
        }),
        JSON.stringify({
            type: "session.shutdown",
            timestamp: "2026-06-10T10:10:00.000Z",
            data: {
                totalNanoAiu: 1000,
                totalPremiumRequests: 3,
                modelMetrics: {
                    "gpt-test": {
                        totalNanoAiu: 900,
                        usage: {
                            inputTokens: 30,
                            outputTokens: 15,
                            cacheReadTokens: 8,
                            cacheWriteTokens: 2,
                            reasoningTokens: 1,
                        },
                        tokenDetails: {
                            input: { tokenCount: 999 },
                            output: { tokenCount: 999 },
                        },
                        requests: { count: 2, cost: 4 },
                    },
                    "gpt-other": {
                        totalNanoAiu: 100,
                        tokenDetails: {
                            input: { tokenCount: 3 },
                            cache_read: { tokenCount: 4 },
                            cache_write: { tokenCount: 5 },
                            output: { tokenCount: 6 },
                        },
                    },
                },
            },
        }),
        "{truncated",
    ].join("\n"));

    const summary = await parseSessionEvents(file, { id: "abc" });

    assert.equal(summary.id, "abc");
    assert.equal(summary.firstSeenAt, Date.UTC(2026, 5, 10, 10));
    assert.equal(summary.lastSeenAt, Date.UTC(2026, 5, 10, 10, 10));
    assert.equal(summary.totalNanoAiu, 1000);
    assert.equal(summary.modelNanoAiu, 1000);
    assert.equal(summary.usageNanoAiu, 100);
    assert.equal(summary.compactionNanoAiu, 200);
    assert.equal(summary.sawShutdown, true);
    assert.equal(summary.parseErrorCount, 1);
    assert.deepEqual(summary.modelMetrics["gpt-test"], {
        totalNanoAiu: 900,
        tokenTotals: {
            inputTokens: 30,
            cacheReadTokens: 8,
            cacheWriteTokens: 2,
            outputTokens: 15,
            reasoningTokens: 1,
            requestCount: 2,
            requestCostUnits: 4,
        },
    });
    assert.deepEqual(summary.modelMetrics["gpt-other"], {
        totalNanoAiu: 100,
        tokenTotals: {
            inputTokens: 3,
            cacheReadTokens: 4,
            cacheWriteTokens: 5,
            outputTokens: 6,
        },
    });
    assert.deepEqual(summary.tokenTotals, {
        inputTokens: 53,
        cacheReadTokens: 19,
        cacheWriteTokens: 7,
        outputTokens: 21,
        reasoningTokens: 1,
        requestCount: 3,
        requestCostUnits: 4,
    });
    assert.ok(!JSON.stringify(summary).includes("do not persist"));
});

test("sums usage-event AIU per model when no shutdown total exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "copilot-cost-jsonl-"));
    const file = join(dir, "events.jsonl");
    await writeFile(file, [
        JSON.stringify({
            type: "assistant.usage",
            timestamp: "2026-06-10T10:00:00.000Z",
            data: {
                model: "gpt-test",
                outputTokens: 10,
                copilotUsage: { totalNanoAiu: 100 },
            },
        }),
        JSON.stringify({
            type: "assistant.usage",
            timestamp: "2026-06-10T10:01:00.000Z",
            data: {
                model: "gpt-test",
                outputTokens: 20,
                copilotUsage: { totalNanoAiu: 200 },
            },
        }),
    ].join("\n"));

    const summary = await parseSessionEvents(file, { id: "abc" });

    assert.equal(summary.usageNanoAiu, 300);
    assert.deepEqual(summary.modelMetrics["gpt-test"], {
        totalNanoAiu: 300,
        tokenTotals: { outputTokens: 30 },
    });
});

test("keeps usage-event model tokens when shutdown model metrics omit tokens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "copilot-cost-jsonl-"));
    const file = join(dir, "events.jsonl");
    await writeFile(file, [
        JSON.stringify({
            type: "assistant.usage",
            timestamp: "2026-06-10T10:00:00.000Z",
            data: {
                model: "gpt-test",
                inputTokens: 100,
                cacheReadTokens: 40,
                outputTokens: 20,
                copilotUsage: { totalNanoAiu: 1_000_000_000 },
            },
        }),
        JSON.stringify({
            type: "session.shutdown",
            timestamp: "2026-06-10T10:05:00.000Z",
            data: {
                totalNanoAiu: 5_000_000_000,
                modelMetrics: {
                    "gpt-test": {
                        totalNanoAiu: 5_000_000_000,
                        requests: { count: 2, cost: 5 },
                    },
                },
            },
        }),
    ].join("\n"));

    const summary = await parseSessionEvents(file, { id: "abc" });

    assert.equal(summary.totalNanoAiu, 5_000_000_000);
    assert.deepEqual(summary.tokenTotals, {
        inputTokens: 100,
        cacheReadTokens: 40,
        outputTokens: 20,
        requestCount: 2,
        requestCostUnits: 5,
    });
    assert.deepEqual(summary.modelMetrics["gpt-test"], {
        totalNanoAiu: 5_000_000_000,
        tokenTotals: {
            inputTokens: 100,
            cacheReadTokens: 40,
            outputTokens: 20,
            requestCount: 2,
            requestCostUnits: 5,
        },
    });
});

test("uses assistant message output tokens as stale-session fallback metrics", async () => {
    const dir = await mkdtemp(join(tmpdir(), "copilot-cost-jsonl-"));
    const file = join(dir, "events.jsonl");
    await writeFile(file, [
        JSON.stringify({
            type: "session.model_change",
            timestamp: "2026-05-10T10:00:00.000Z",
            data: { newModel: "gpt-test" },
        }),
        JSON.stringify({
            type: "assistant.message",
            timestamp: "2026-05-10T10:00:10.000Z",
            data: { outputTokens: 10, content: "do not persist this message" },
        }),
        JSON.stringify({
            type: "assistant.message",
            timestamp: "2026-05-10T10:00:20.000Z",
            data: { model: "gpt-other", outputTokens: 20 },
        }),
        JSON.stringify({
            type: "tool.execution_complete",
            timestamp: "2026-05-10T10:00:30.000Z",
            data: { model: "gpt-tool" },
        }),
        JSON.stringify({
            type: "assistant.message",
            timestamp: "2026-05-10T10:00:40.000Z",
            data: { outputTokens: 30 },
        }),
    ].join("\n"));

    const summary = await parseSessionEvents(file, { id: "abc" });

    assert.deepEqual(summary.tokenTotals, { outputTokens: 60 });
    assert.deepEqual(summary.modelMetrics, {
        "gpt-test": { tokenTotals: { outputTokens: 40 } },
        "gpt-other": { tokenTotals: { outputTokens: 20 } },
    });
    assert.ok(!JSON.stringify(summary).includes("do not persist"));
});

test("ignores assistant message fallback metrics when richer usage events exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "copilot-cost-jsonl-"));
    const file = join(dir, "events.jsonl");
    await writeFile(file, [
        JSON.stringify({
            type: "assistant.message",
            timestamp: "2026-06-10T10:00:00.000Z",
            data: { model: "gpt-test", outputTokens: 999 },
        }),
        JSON.stringify({
            type: "assistant.usage",
            timestamp: "2026-06-10T10:00:01.000Z",
            data: { model: "gpt-test", outputTokens: 10 },
        }),
    ].join("\n"));

    const summary = await parseSessionEvents(file, { id: "abc" });

    assert.deepEqual(summary.tokenTotals, { outputTokens: 10 });
    assert.deepEqual(summary.modelMetrics["gpt-test"], { tokenTotals: { outputTokens: 10 } });
});

test("uses session directory name as the default id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "copilot-cost-session-"));
    const file = join(dir, "events.jsonl");
    await writeFile(file, `${JSON.stringify({ type: "session.shutdown", timestamp: "2026-06-10T10:00:00.000Z", data: {} })}\n`);

    const summary = await parseSessionEvents(file);

    assert.equal(summary.id, dir.split("/").at(-1));
    assert.equal(summary.sawShutdown, true);
});
