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
        usageTokenTotals: undefined,
        messageTokenTotals: undefined,
        compactionTokenTotals: undefined,
        shutdownTokenTotals: undefined,
        shutdownType: undefined,
        sawShutdown: false,
        sawShutdownMetrics: false,
        activeModel: undefined,
        lastModel: undefined,
        messageModelMetrics: {},
        compactionModelMetrics: {},
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

    return dropEmpty(finalizeSummary(summary));
}

function collectEvent(summary, event) {
    const data = event?.data ?? {};
    if (event.type === "assistant.usage") {
        collectAssistantUsage(summary, data);
        return;
    }
    if (event.type === "assistant.message") {
        collectAssistantMessage(summary, data);
        return;
    }
    if (event.type === "session.model_change") {
        collectModelChange(summary, data);
        return;
    }
    if (event.type === "tool.execution_start" || event.type === "tool.execution_complete") {
        collectToolModel(summary, data);
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
    summary.usageTokenTotals = addTokenTotals(summary.usageTokenTotals, tokens);
    summary.tokenTotals = addTokenTotals(summary.tokenTotals, tokens);
    const model = modelName(data);
    if (model) {
        summary.lastModel = model;
        mergeModelMetric(summary, model, { tokenTotals: tokens, totalNanoAiu: nano }, { totalMode: "add" });
    }
}

function collectAssistantMessage(summary, data) {
    const model = modelName(data) ?? summary.activeModel ?? summary.lastModel;
    if (model) {
        summary.lastModel = model;
    }
    const tokens = cleanTokens({ outputTokens: optNum(data.outputTokens) });
    summary.messageTokenTotals = addTokenTotals(summary.messageTokenTotals, tokens);
    if (model && tokens) {
        mergeModelMetric(summary, model, { tokenTotals: tokens }, {
            targetKey: "messageModelMetrics",
            totalMode: "add",
        });
    }
}

function collectModelChange(summary, data) {
    const model = stringValue(data.newModel) ?? stringValue(data.model);
    if (model) {
        summary.activeModel = model;
        summary.lastModel = model;
    }
}

function collectToolModel(summary, data) {
    const model = modelName(data);
    if (model) {
        summary.lastModel = model;
    }
}

function collectCompaction(summary, data) {
    const usage = data.compactionTokensUsed ?? {};
    const nano = optNum(usage.copilotUsage?.totalNanoAiu);
    if (nano !== undefined) {
        summary.compactionNanoAiu = num(summary.compactionNanoAiu) + nano;
    }
    const tokens = tokenTotalsFromUsage(usage);
    summary.compactionTokenTotals = addTokenTotals(summary.compactionTokenTotals, tokens);
    summary.tokenTotals = addTokenTotals(summary.tokenTotals, tokens);
    const model = modelName(usage) ?? summary.activeModel ?? summary.lastModel;
    if (model && (tokens || nano !== undefined)) {
        mergeModelMetric(summary, model, { tokenTotals: tokens, totalNanoAiu: nano }, {
            targetKey: "compactionModelMetrics",
            totalMode: "add",
        });
    }
}

function collectShutdown(summary, data) {
    summary.sawShutdown = true;
    if (typeof data.shutdownType === "string" && data.shutdownType.trim()) {
        summary.shutdownType = data.shutdownType.trim();
    }
    const total = optNum(data.totalNanoAiu);
    if (total !== undefined) {
        summary.totalNanoAiu = total;
    }

    const modelMetrics = shutdownModelMetricsWithFallback(modelMetricsFromShutdown(data.modelMetrics), summary.modelMetrics);
    if (Object.keys(modelMetrics).length) {
        summary.sawShutdownMetrics = true;
        summary.modelMetrics = modelMetrics;
    }

    const modelNanoAiu = Object.values(modelMetrics).reduce((sum, metrics) => sum + num(metrics.totalNanoAiu), 0);
    if (modelNanoAiu > 0) {
        summary.modelNanoAiu = modelNanoAiu;
    }

    const tokenTotals = Object.values(modelMetrics)
        .map((metrics) => metrics.tokenTotals)
        .reduce((totals, tokens) => addTokenTotals(totals, tokens), undefined);
    summary.shutdownTokenTotals = addTokenTotals(summary.shutdownTokenTotals, tokenTotals);
    summary.tokenTotals = addTokenTotals(tokenTotals, summary.compactionTokenTotals);
    const totalPremiumRequests = optNum(data.totalPremiumRequests);
    if (totalPremiumRequests !== undefined) {
        summary.shutdownTokenTotals = {
            ...(summary.shutdownTokenTotals ?? {}),
            requestCount: totalPremiumRequests,
        };
        summary.tokenTotals = {
            ...(summary.tokenTotals ?? {}),
            requestCount: totalPremiumRequests,
        };
    }
}

function finalizeSummary(summary) {
    if (summary.sawShutdownMetrics) {
        summary.tokenTotals = addTokenTotals(summary.shutdownTokenTotals, summary.compactionTokenTotals);
    } else if (summary.usageTokenTotals) {
        summary.tokenTotals = addTokenTotals(summary.usageTokenTotals, summary.compactionTokenTotals);
    } else {
        summary.tokenTotals = addTokenTotals(summary.messageTokenTotals, summary.compactionTokenTotals);
        mergeModelMetrics(summary.modelMetrics, summary.messageModelMetrics);
        mergeModelMetrics(summary.modelMetrics, summary.compactionModelMetrics);
    }
    delete summary.usageTokenTotals;
    delete summary.messageTokenTotals;
    delete summary.compactionTokenTotals;
    delete summary.shutdownTokenTotals;
    delete summary.sawShutdownMetrics;
    delete summary.activeModel;
    delete summary.lastModel;
    delete summary.messageModelMetrics;
    delete summary.compactionModelMetrics;
    return summary;
}

export function modelMetricsFromShutdown(modelMetrics = {}) {
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

function shutdownModelMetricsWithFallback(shutdownMetrics, fallbackMetrics = {}) {
    const next = {};
    for (const [model, metrics] of Object.entries(shutdownMetrics)) {
        const fallback = fallbackMetrics[model];
        const tokenTotals = hasTokenClassTotals(metrics.tokenTotals)
            ? metrics.tokenTotals
            : addTokenTotals(fallback?.tokenTotals, metrics.tokenTotals);
        next[model] = dropEmpty({
            totalNanoAiu: metrics.totalNanoAiu,
            tokenTotals,
        });
    }
    return next;
}

function hasTokenClassTotals(tokens = {}) {
    return ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens"]
        .some((key) => optNum(tokens?.[key]) !== undefined);
}

function mergeModelMetric(summary, model, patch, { targetKey = "modelMetrics", totalMode = "replace" } = {}) {
    const target = summary[targetKey];
    const prior = target[model] ?? {};
    const patchTotal = optNum(patch.totalNanoAiu);
    target[model] = dropEmpty({
        totalNanoAiu: totalMode === "add" && patchTotal !== undefined
            ? num(prior.totalNanoAiu) + patchTotal
            : patchTotal ?? prior.totalNanoAiu,
        tokenTotals: addTokenTotals(prior.tokenTotals, patch.tokenTotals),
    });
}

function mergeModelMetrics(target, source) {
    for (const [model, metrics] of Object.entries(source ?? {})) {
        const prior = target[model] ?? {};
        target[model] = dropEmpty({
            totalNanoAiu: optNum(prior.totalNanoAiu) ?? optNum(metrics.totalNanoAiu),
            tokenTotals: addTokenTotals(prior.tokenTotals, metrics.tokenTotals),
        });
    }
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
