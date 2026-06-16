import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    defaultVsCodeUserRoots,
    discoverVsCodeTelemetryFiles,
    parseVsCodeTelemetryGroups,
} from "../../src/domain/vscode-session.mjs";
import { SURFACE_VSCODE } from "../../src/domain/session-ledger.mjs";

test("parses VS Code delta chat JSONL credits and tokens without retaining content", async () => {
    const root = await tempUserRoot();
    const workspace = join(root, "workspaceStorage", "workspace-a");
    const chatDir = join(workspace, "chatSessions");
    await mkdir(chatDir, { recursive: true });
    const file = join(chatDir, "session-a.jsonl");
    await writeFile(file, [
        JSON.stringify({
            kind: 0,
            v: {
                sessionId: "session-a",
                requests: [],
                inputState: {
                    selectedModel: {
                        metadata: {
                            name: "GPT-5.3-Codex",
                        },
                    },
                },
            },
        }),
        JSON.stringify({ kind: 1, k: ["customTitle"], v: "secret title should not survive" }),
        JSON.stringify({
            kind: 2,
            k: ["requests"],
            v: [{
                requestId: "request-a",
                timestamp: Date.UTC(2026, 5, 10, 10),
                modelId: "copilot/auto",
                responseId: "response-a",
                result: {
                    details: "GPT-5.3-Codex • 2.4 credits",
                    metadata: {
                        sessionId: "session-a",
                        resolvedModel: "gpt-5.3-codex",
                        promptTokens: 22615,
                        outputTokens: 35,
                    },
                },
                message: { text: "XXCOPILOT_COSTXX" },
                response: [{ value: "XXCOPILOT_COST_RESPONSEXX" }],
            }],
        }),
    ].join("\n"));

    const summaries = await parseVsCodeTelemetryGroups(await discoverVsCodeTelemetryFiles({ userRoots: [root] }));

    assert.equal(summaries.length, 1);
    const [summary] = summaries;
    assert.match(summary.id, /^vscode:/);
    assert.equal(summary.surface, SURFACE_VSCODE);
    assert.equal(summary.firstSeenAt, Date.UTC(2026, 5, 10, 10));
    assert.equal(summary.lastSeenAt, Date.UTC(2026, 5, 10, 10));
    assert.equal(summary.usageNanoAiu, 2_400_000_000);
    assert.deepEqual(summary.tokenTotals, {
        inputTokens: 22615,
        outputTokens: 35,
        requestCount: 1,
    });
    assert.deepEqual(summary.modelMetrics["gpt-5.3-codex"], {
        totalNanoAiu: 2_400_000_000,
        tokenTotals: {
            inputTokens: 22615,
            outputTokens: 35,
            requestCount: 1,
        },
    });
    assert.ok(!JSON.stringify(summary).includes("XXCOPILOT"));
});

test("parses plain JSON sessions and debug llm_request events as one grouped session", async () => {
    const root = await tempUserRoot();
    const workspace = join(root, "workspaceStorage", "workspace-a");
    const chatDir = join(workspace, "chatSessions");
    const debugDir = join(workspace, "GitHub.copilot-chat", "debug-logs", "session-b");
    await mkdir(chatDir, { recursive: true });
    await mkdir(debugDir, { recursive: true });
    await writeFile(join(chatDir, "session-b.json"), JSON.stringify({
        requests: [{
            requestId: "request-b",
            timestamp: Date.UTC(2026, 5, 11, 10),
            result: {
                details: "GPT-5.3-Codex • 1 credits",
                metadata: {
                    sessionId: "session-b",
                    resolvedModel: "gpt-5.3-codex",
                    promptTokens: 10,
                    outputTokens: 2,
                },
            },
        }],
    }));
    await writeFile(join(debugDir, "main.jsonl"), [
        JSON.stringify({
            type: "llm_request",
            ts: Date.UTC(2026, 5, 11, 10, 0, 1),
            sid: "session-b",
            spanId: "debug-b",
            attrs: {
                requestId: "request-b",
                model: "gpt-5.3-codex",
                inputTokens: 20,
                outputTokens: 4,
                cachedTokens: 8,
                copilotUsageNanoAiu: 2_000_000_000,
            },
        }),
        JSON.stringify({
            type: "session_start",
            ts: Date.UTC(2026, 5, 11, 10),
            sid: "session-b",
            attrs: {},
        }),
    ].join("\n"));

    const summaries = await parseVsCodeTelemetryGroups(await discoverVsCodeTelemetryFiles({ userRoots: [root] }));

    assert.equal(summaries.length, 1);
    const [summary] = summaries;
    assert.equal(summary.usageNanoAiu, 2_000_000_000);
    assert.deepEqual(summary.modelMetrics["gpt-5.3-codex"], {
        totalNanoAiu: 2_000_000_000,
        tokenTotals: {
            inputTokens: 20,
            cacheReadTokens: 8,
            outputTokens: 4,
            requestCount: 1,
        },
    });
});

test("discovers compatible roots and ignores noisy files", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-vscode-home-"));
    const [root] = defaultVsCodeUserRoots({ home, platform: "darwin", env: {} });
    const chatDir = join(root, "workspaceStorage", "workspace-a", "chatSessions");
    const debugDir = join(root, "workspaceStorage", "workspace-a", "GitHub.copilot-chat", "debug-logs", "session-c");
    await mkdir(chatDir, { recursive: true });
    await mkdir(debugDir, { recursive: true });
    await writeFile(join(chatDir, "session-c.jsonl"), JSON.stringify({ kind: 0, v: { sessionId: "session-c" } }));
    await writeFile(join(debugDir, "models.json"), "{}");
    await writeFile(join(debugDir, "main.jsonl"), JSON.stringify({ type: "session_start", sid: "session-c" }));

    const files = await discoverVsCodeTelemetryFiles({ userRoots: defaultVsCodeUserRoots({ home, platform: "darwin", env: {} }) });

    assert.deepEqual(files.map((file) => file.path).sort(), [
        join(chatDir, "session-c.jsonl"),
        join(debugDir, "main.jsonl"),
    ].sort());
});

async function tempUserRoot() {
    return mkdtemp(join(tmpdir(), "copilot-cost-vscode-user-"));
}
