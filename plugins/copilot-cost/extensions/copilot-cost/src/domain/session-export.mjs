// Exports local session telemetry and ledger rows as JSONL fixture data.
// The export keeps cost/token/session metadata and deliberately avoids prompts,
// assistant text, transcript text, tool arguments, and source code.

import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { optNum } from "../math.mjs";
import { timestampMs } from "../render/format.mjs";
import { sessionLedgerPath, sessionStateRootPath } from "../storage.mjs";
import { readSessionLedger } from "./session-ledger.mjs";
import { discoverSessionEventFiles } from "./session-sync.mjs";
import { modelMetricsFromShutdown } from "./session-jsonl.mjs";

export const SESSION_EXPORT_FILENAME = "COPILOT_COST_DEBUG.jsonl";

export async function exportSessionData({
    sessionStateRoot = sessionStateRootPath(),
    ledgerPath = sessionLedgerPath(),
    cwd = process.cwd(),
    outputPath = join(cwd, SESSION_EXPORT_FILENAME),
} = {}) {
    const [ledger, eventFiles] = await Promise.all([
        readSessionLedger(ledgerPath),
        discoverSessionEventFiles(sessionStateRoot),
    ]);
    const eventsBySession = new Map();
    for (const file of eventFiles) {
        eventsBySession.set(file.id, await extractEventFile(file));
    }

    const sessionIds = new Set([
        ...eventsBySession.keys(),
        ...Object.keys(ledger.sessions ?? {}),
    ]);
    const records = [...sessionIds]
        .map((sessionId) => ({
            sessionId,
            eventFile: eventsBySession.get(sessionId)?.eventFile ?? null,
            events: eventsBySession.get(sessionId)?.events ?? null,
            extracted: eventsBySession.get(sessionId)?.extracted ?? null,
            ledgerSession: ledger.sessions?.[sessionId] ?? null,
        }))
        .sort(compareSessionRecords);

    const resolvedOutputPath = resolve(outputPath);
    await writeFile(resolvedOutputPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    return { outputPath: resolvedOutputPath, sessionCount: records.length };
}

async function extractEventFile(file) {
    const record = emptyEventRecord(file);
    const lines = createInterface({
        input: createReadStream(file.path, { encoding: "utf8" }),
        crlfDelay: Infinity,
    });

    for await (const line of lines) {
        if (!line.trim()) {
            continue;
        }
        record.events.lineCount += 1;
        collectLine(record, line);
    }

    finalizeEventRecord(record);
    return record;
}

function emptyEventRecord(file) {
    return {
        eventFile: {
            path: sanitizedEventFilePath(file),
            size: file.size,
            mtimeMs: file.mtimeMs,
        },
        events: {
            lineCount: 0,
            parsedCount: 0,
            parseErrorCount: 0,
            firstTimestamp: null,
            firstTimestampMs: undefined,
            lastTimestamp: null,
            lastTimestampMs: undefined,
            typeCounts: {},
            dataKeyCountsByType: {},
        },
        extracted: {
            "assistant.usage": {
                count: 0,
                copilotUsage: { totalNanoAiuSum: 0, totalNanoAiuValueCount: 0 },
                tokenTotals: {},
                modelCounts: {},
            },
            "session.compaction_complete": {
                count: 0,
                successCount: 0,
                compactionTokensUsed: {
                    copilotUsage: { totalNanoAiuSum: 0, totalNanoAiuValueCount: 0 },
                    tokenTotals: {},
                },
            },
            "session.shutdown": {
                count: 0,
                totalNanoAiuValues: [],
                totalPremiumRequestsValues: [],
                modelMetrics: {},
            },
            tokenTotals: {},
            modelsSeen: {},
            summary: {
                bestCostSource: "none",
                bestTotalNanoAiu: undefined,
            },
        },
    };
}

function sanitizedEventFilePath(file) {
    return `<session-state>/${file.id}/${basename(file.path)}`;
}

function collectLine(record, line) {
    let event;
    try {
        event = JSON.parse(line);
    } catch {
        record.events.parseErrorCount += 1;
        return;
    }

    record.events.parsedCount += 1;
    const type = event.type || "(missing)";
    addCount(record.events.typeCounts, type);
    collectEventShape(record, type, event.data);
    collectTimestamp(record, event.timestamp);

    if (type === "assistant.usage") {
        collectAssistantUsage(record, event.data ?? {});
    } else if (type === "session.compaction_complete") {
        collectCompaction(record, event.data ?? {});
    } else if (type === "session.shutdown") {
        collectShutdown(record, event.data ?? {});
    }
}

function collectEventShape(record, type, data) {
    record.events.dataKeyCountsByType[type] ??= {};
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        return;
    }
    for (const key of Object.keys(data)) {
        addCount(record.events.dataKeyCountsByType[type], key);
    }
}

function collectTimestamp(record, timestamp) {
    const ms = timestampMs(timestamp);
    record.events.firstTimestampMs = minDefined(record.events.firstTimestampMs, ms);
    record.events.lastTimestampMs = maxDefined(record.events.lastTimestampMs, ms);
}

function collectAssistantUsage(record, data) {
    const target = record.extracted["assistant.usage"];
    target.count += 1;

    const totalNanoAiu = optNum(data.copilotUsage?.totalNanoAiu);
    if (totalNanoAiu !== undefined) {
        target.copilotUsage.totalNanoAiuSum += totalNanoAiu;
        target.copilotUsage.totalNanoAiuValueCount += 1;
    }

    const tokens = tokenTotalsFromUsage(data);
    addTokenTotals(target.tokenTotals, tokens);
    addTokenTotals(record.extracted.tokenTotals, tokens);

    const model = modelName(data);
    if (model) {
        addCount(target.modelCounts, model);
        addCount(record.extracted.modelsSeen, model);
    }
}

function collectCompaction(record, data) {
    const target = record.extracted["session.compaction_complete"];
    target.count += 1;
    if (data.success) {
        target.successCount += 1;
    }

    const usage = data.compactionTokensUsed ?? {};
    const totalNanoAiu = optNum(usage.copilotUsage?.totalNanoAiu);
    if (totalNanoAiu !== undefined) {
        target.compactionTokensUsed.copilotUsage.totalNanoAiuSum += totalNanoAiu;
        target.compactionTokensUsed.copilotUsage.totalNanoAiuValueCount += 1;
    }

    const tokens = tokenTotalsFromUsage(usage);
    addTokenTotals(target.compactionTokensUsed.tokenTotals, tokens);
    addTokenTotals(record.extracted.tokenTotals, tokens);
}

function collectShutdown(record, data) {
    const target = record.extracted["session.shutdown"];
    target.count += 1;

    const totalNanoAiu = optNum(data.totalNanoAiu);
    if (totalNanoAiu !== undefined) {
        target.totalNanoAiuValues.push(totalNanoAiu);
    }

    const totalPremiumRequests = optNum(data.totalPremiumRequests);
    if (totalPremiumRequests !== undefined) {
        target.totalPremiumRequestsValues.push(totalPremiumRequests);
    }

    for (const [model, metrics] of Object.entries(modelMetricsFromShutdown(data.modelMetrics))) {
        target.modelMetrics[model] ??= {
            totalNanoAiuValues: [],
            tokenTotals: {},
        };
        addCount(record.extracted.modelsSeen, model);
        if (metrics.totalNanoAiu !== undefined) {
            target.modelMetrics[model].totalNanoAiuValues.push(metrics.totalNanoAiu);
        }
        addTokenTotals(target.modelMetrics[model].tokenTotals, metrics.tokenTotals);
        addTokenTotals(record.extracted.tokenTotals, metrics.tokenTotals);
    }
}

function finalizeEventRecord(record) {
    record.events.firstTimestamp = isoOrNull(record.events.firstTimestampMs);
    record.events.lastTimestamp = isoOrNull(record.events.lastTimestampMs);

    const shutdownTotal = lastValue(record.extracted["session.shutdown"].totalNanoAiuValues);
    const shutdownModelTotal = sumLastModelTotals(record.extracted["session.shutdown"].modelMetrics);
    const usageTotal = record.extracted["assistant.usage"].copilotUsage.totalNanoAiuSum
        + record.extracted["session.compaction_complete"].compactionTokensUsed.copilotUsage.totalNanoAiuSum;

    record.extracted.summary.bestCostSource =
        shutdownTotal !== undefined ? "session.shutdown.totalNanoAiu"
            : shutdownModelTotal !== undefined ? "session.shutdown.modelMetrics.*.totalNanoAiu"
                : usageTotal > 0 ? "assistant.usage + session.compaction_complete"
                    : "none";
    record.extracted.summary.bestTotalNanoAiu = shutdownTotal ?? shutdownModelTotal ?? (usageTotal > 0 ? usageTotal : undefined);
}

function compareSessionRecords(left, right) {
    const leftAt = left.events?.lastTimestampMs ?? left.eventFile?.mtimeMs ?? left.ledgerSession?.lastSeenAt ?? 0;
    const rightAt = right.events?.lastTimestampMs ?? right.eventFile?.mtimeMs ?? right.ledgerSession?.lastSeenAt ?? 0;
    return rightAt - leftAt;
}

function tokenTotalsFromUsage(usage = {}) {
    return cleanTokens({
        inputTokens: optNum(usage?.inputTokens),
        cacheReadTokens: optNum(usage?.cacheReadTokens),
        cacheWriteTokens: optNum(usage?.cacheWriteTokens),
        outputTokens: optNum(usage?.outputTokens),
        reasoningTokens: optNum(usage?.reasoningTokens),
    });
}

function addTokenTotals(target, patch = {}) {
    for (const [key, value] of Object.entries(patch ?? {})) {
        const number = optNum(value);
        if (number !== undefined) {
            target[key] = (optNum(target[key]) ?? 0) + number;
        }
    }
}

function cleanTokens(value = {}) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => optNum(item) !== undefined && item > 0));
}

function modelName(data = {}) {
    return stringValue(data.model)
        ?? stringValue(data.modelName)
        ?? stringValue(data.currentModel)
        ?? stringValue(data.request?.model);
}

function stringValue(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function addCount(counts, key, by = 1) {
    counts[key] = (counts[key] ?? 0) + by;
}

function isoOrNull(ms) {
    return optNum(ms) === undefined ? null : new Date(ms).toISOString();
}

function minDefined(left, right) {
    if (left === undefined) {
        return right;
    }
    if (right === undefined) {
        return left;
    }
    return Math.min(left, right);
}

function maxDefined(left, right) {
    if (left === undefined) {
        return right;
    }
    if (right === undefined) {
        return left;
    }
    return Math.max(left, right);
}

function lastValue(values) {
    return values.length ? values[values.length - 1] : undefined;
}

function sumLastModelTotals(modelMetrics) {
    let total = 0;
    let found = false;
    for (const metrics of Object.values(modelMetrics)) {
        const value = lastValue(metrics.totalNanoAiuValues);
        if (value !== undefined) {
            total += value;
            found = true;
        }
    }
    return found ? total : undefined;
}
