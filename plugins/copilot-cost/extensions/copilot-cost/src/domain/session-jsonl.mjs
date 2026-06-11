// Streams Copilot session events and keeps only compact cost/token metadata.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createInterface } from "node:readline";

import { optNum } from "../math.mjs";
import { timestampMs } from "../render/format.mjs";

export async function parseSessionEvents(filePath, { id } = {}) {
    const file = await stat(filePath);
    const summary = {
        id: id ?? basename(dirname(filePath)),
        firstSeenAt: undefined,
        lastSeenAt: undefined,
        totalNanoAiu: undefined,
        modelNanoAiu: undefined,
        usageNanoAiu: undefined,
        compactionNanoAiu: undefined,
        tokenTotals: undefined,
        modelMetrics: {},
        eventFileMtimeMs: file.mtimeMs,
        eventFileSize: file.size,
        parseErrorCount: 0,
    };

    const input = createInterface({
        input: createReadStream(filePath, { encoding: "utf8" }),
        crlfDelay: Infinity,
    });

    for await (const line of input) {
        if (!line.trim()) {
            continue;
        }
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            summary.parseErrorCount += 1;
            continue;
        }

        const at = timestampMs(event.timestamp);
        summary.firstSeenAt = minDefined(summary.firstSeenAt, at);
        summary.lastSeenAt = maxDefined(summary.lastSeenAt, at);
        collectEvent(summary, event);
    }

    return dropEmpty(summary);
}

function collectEvent(summary, event) {
    const data = event?.data ?? {};
    if (event.type === "assistant.usage") {
        collectAssistantUsage(summary, data);
        return;
    }
    if (event.type === "session.compaction_complete") {
        collectCompaction(summary, data);
        return;
    }
    if (event.type === "session.shutdown") {
        collectShutdown(summary, data);
    }
}

function collectAssistantUsage(summary, data) {
    const nano = optNum(data.copilotUsage?.totalNanoAiu);
    if (nano !== undefined) {
        summary.usageNanoAiu = num(summary.usageNanoAiu) + nano;
    }
    const tokens = tokenTotalsFromUsage(data);
    summary.tokenTotals = addTokenTotals(summary.tokenTotals, tokens);
    const model = modelName(data);
    if (model) {
        mergeModelMetric(summary, model, { tokenTotals: tokens, totalNanoAiu: nano });
    }
}

function collectCompaction(summary, data) {
    const usage = data.compactionTokensUsed ?? {};
    const nano = optNum(usage.copilotUsage?.totalNanoAiu);
    if (nano !== undefined) {
        summary.compactionNanoAiu = num(summary.compactionNanoAiu) + nano;
    }
    summary.tokenTotals = addTokenTotals(summary.tokenTotals, tokenTotalsFromUsage(usage));
}

function collectShutdown(summary, data) {
    const total = optNum(data.totalNanoAiu);
    if (total !== undefined) {
        summary.totalNanoAiu = total;
    }

    const modelMetrics = collectModelMetrics(data.modelMetrics);
    for (const [model, metrics] of Object.entries(modelMetrics)) {
        mergeModelMetric(summary, model, metrics);
    }

    const modelNanoAiu = Object.values(modelMetrics).reduce((sum, metrics) => sum + num(metrics.totalNanoAiu), 0);
    if (modelNanoAiu > 0) {
        summary.modelNanoAiu = modelNanoAiu;
    }

    const tokenTotals = Object.values(modelMetrics)
        .map((metrics) => metrics.tokenTotals)
        .reduce((totals, tokens) => addTokenTotals(totals, tokens), undefined);
    summary.tokenTotals = addTokenTotals(summary.tokenTotals, tokenTotals);
    const totalPremiumRequests = optNum(data.totalPremiumRequests);
    if (totalPremiumRequests !== undefined) {
        summary.tokenTotals = addTokenTotals(summary.tokenTotals, { requestCount: totalPremiumRequests });
    }
}

function collectModelMetrics(modelMetrics = {}) {
    if (!modelMetrics || typeof modelMetrics !== "object") {
        return {};
    }
    return Object.fromEntries(Object.entries(modelMetrics).map(([model, metrics]) => {
        const requests = metrics?.requests ?? {};
        const usageTokens = tokenTotalsFromUsage(metrics?.usage);
        return [model, {
            totalNanoAiu: optNum(metrics?.totalNanoAiu),
            tokenTotals: addTokenTotals(
                usageTokens ?? tokenTotalsFromTokenDetails(metrics?.tokenDetails),
                {
                    requestCount: optNum(requests.count),
                    requestCostUnits: optNum(requests.cost),
                },
            ),
        }];
    }).filter(([model]) => typeof model === "string" && model.trim()));
}

function mergeModelMetric(summary, model, patch) {
    const prior = summary.modelMetrics[model] ?? {};
    summary.modelMetrics[model] = {
        totalNanoAiu: maxDefined(prior.totalNanoAiu, patch.totalNanoAiu),
        tokenTotals: addTokenTotals(prior.tokenTotals, patch.tokenTotals),
    };
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

function tokenTotalsFromTokenDetails(details = {}) {
    return cleanTokens({
        inputTokens: tokenCount(details.input),
        cacheReadTokens: tokenCount(details.cache_read) ?? tokenCount(details.cacheRead),
        cacheWriteTokens: tokenCount(details.cache_write) ?? tokenCount(details.cacheWrite),
        outputTokens: tokenCount(details.output),
        reasoningTokens: tokenCount(details.reasoning),
    });
}

function tokenCount(value) {
    return optNum(value?.tokenCount);
}

function addTokenTotals(left, right) {
    const keys = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "requestCount", "requestCostUnits"];
    const totals = {};
    for (const key of keys) {
        const value = num(left?.[key]) + num(right?.[key]);
        if (value > 0) {
            totals[key] = value;
        }
    }
    return Object.keys(totals).length ? totals : undefined;
}

function cleanTokens(value) {
    const tokens = Object.fromEntries(Object.entries(value).filter(([, item]) => optNum(item) !== undefined && item > 0));
    return Object.keys(tokens).length ? tokens : undefined;
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

function num(value) {
    return optNum(value) ?? 0;
}

function dropEmpty(summary) {
    return Object.fromEntries(Object.entries(summary).filter(([, value]) => {
        if (value === undefined) {
            return false;
        }
        if (value && typeof value === "object" && !Array.isArray(value)) {
            return Object.keys(value).length > 0;
        }
        return true;
    }));
}
