// Opt-in probe for discovering native extension usage events without logging
// prompt or response content. Enable with COPILOT_COST_DEBUG_EVENTS=1.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { optNum } from "../math.mjs";
import { pluginDataDirectory } from "../storage.mjs";

const DEBUG_EVENTS = [
    "assistant.message",
    "assistant.streaming_delta",
    "assistant.turn_start",
    "assistant.usage",
    "permission.requested",
    "session.compaction_complete",
    "session.error",
    "session.idle",
    "session.usage_info",
    "tool.execution_complete",
    "tool.execution_start",
    "user.message",
];
const USAGE_PROBE_EVENTS = new Set([
    "assistant.message",
    "assistant.turn_start",
    "assistant.usage",
    "session.compaction_complete",
    "session.idle",
    "session.usage_info",
    "user.message",
]);

export function installCostDebugProbe(session, {
    enabled = process.env.COPILOT_COST_DEBUG_EVENTS === "1",
    outputPath = join(pluginDataDirectory(), "debug-events.jsonl"),
} = {}) {
    if (!enabled || !session?.on) {
        return false;
    }

    for (const name of DEBUG_EVENTS) {
        session.on(name, (event) => {
            void writeDebugRecord(outputPath, eventRecord(name, event))
                .then(() => {
                    if (USAGE_PROBE_EVENTS.has(name)) {
                        return probeUsageMetrics(session, outputPath, name);
                    }
                    return undefined;
                });
        });
    }
    return true;
}

async function probeUsageMetrics(session, outputPath, trigger) {
    const getMetrics = session?.rpc?.usage?.getMetrics;
    if (typeof getMetrics !== "function") {
        return;
    }
    try {
        const metrics = await getMetrics.call(session.rpc.usage);
        await writeDebugRecord(outputPath, {
            kind: "rpc.usage.getMetrics",
            trigger,
            at: new Date().toISOString(),
            data: sanitizeUsageMetrics(metrics),
        });
    } catch (error) {
        await writeDebugRecord(outputPath, {
            kind: "rpc.usage.getMetrics.error",
            trigger,
            at: new Date().toISOString(),
            error: error?.message,
        });
    }
}

function eventRecord(name, event = {}) {
    return {
        kind: "event",
        name,
        at: new Date().toISOString(),
        timestamp: event?.timestamp,
        agentId: event?.agentId,
        dataKeys: objectKeys(event?.data),
        data: sanitizeUsageMetrics(event?.data),
    };
}

function sanitizeUsageMetrics(value) {
    if (!value || typeof value !== "object") {
        return undefined;
    }
    return dropUndefined({
        totalNanoAiu: optNum(value.totalNanoAiu),
        total_nano_aiu: optNum(value.total_nano_aiu),
        currentTokens: optNum(value.currentTokens),
        tokenLimit: optNum(value.tokenLimit),
        inputTokens: optNum(value.inputTokens),
        outputTokens: optNum(value.outputTokens),
        cacheReadTokens: optNum(value.cacheReadTokens),
        cacheWriteTokens: optNum(value.cacheWriteTokens),
        reasoningTokens: optNum(value.reasoningTokens),
        copilotUsage: sanitizeUsageMetrics(value.copilotUsage),
        ai_used: sanitizeUsageMetrics(value.ai_used),
        modelMetrics: modelMetricKeys(value.modelMetrics),
    });
}

function modelMetricKeys(value) {
    if (!value || typeof value !== "object") {
        return undefined;
    }
    return Object.fromEntries(Object.entries(value).map(([model, metrics]) => [model, {
        keys: objectKeys(metrics),
        usageKeys: objectKeys(metrics?.usage),
        requestKeys: objectKeys(metrics?.requests),
        totalNanoAiu: optNum(metrics?.totalNanoAiu),
    }]));
}

function objectKeys(value) {
    return value && typeof value === "object" ? Object.keys(value).sort() : undefined;
}

async function writeDebugRecord(path, record) {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(dropUndefined(record))}\n`);
}

function dropUndefined(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
