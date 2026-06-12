// Built-in fallback rates from GitHub Copilot's published AI-credit model pricing.
// Values are USD per 1M tokens; callers convert through BILLING's AI-credit constants.

import { BILLING } from "../config.mjs";
import { optNum } from "../math.mjs";

const MILLION = 1_000_000;
const TOKEN_KEYS = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens"];

const MODEL_PRICING = [
    pricing("GPT-5 mini", { inputTokens: 0.25, cacheReadTokens: 0.025, outputTokens: 2.00 }),
    pricing("GPT-5.3-Codex", { inputTokens: 1.75, cacheReadTokens: 0.175, outputTokens: 14.00 }),
    tieredPricing("GPT-5.4", 272_000, {
        inputTokens: 2.50,
        cacheReadTokens: 0.25,
        outputTokens: 15.00,
    }, {
        inputTokens: 5.00,
        cacheReadTokens: 0.50,
        outputTokens: 22.50,
    }),
    pricing("GPT-5.4 mini", { inputTokens: 0.75, cacheReadTokens: 0.075, outputTokens: 4.50 }),
    pricing("GPT-5.4 nano", { inputTokens: 0.20, cacheReadTokens: 0.02, outputTokens: 1.25 }),
    tieredPricing("GPT-5.5", 272_000, {
        inputTokens: 5.00,
        cacheReadTokens: 0.50,
        outputTokens: 30.00,
    }, {
        inputTokens: 10.00,
        cacheReadTokens: 1.00,
        outputTokens: 45.00,
    }),
    pricing("Claude Haiku 4.5", { inputTokens: 1.00, cacheReadTokens: 0.10, cacheWriteTokens: 1.25, outputTokens: 5.00 }),
    pricing("Claude Sonnet 4", { inputTokens: 3.00, cacheReadTokens: 0.30, cacheWriteTokens: 3.75, outputTokens: 15.00 }),
    pricing("Claude Sonnet 4.5", { inputTokens: 3.00, cacheReadTokens: 0.30, cacheWriteTokens: 3.75, outputTokens: 15.00 }),
    pricing("Claude Sonnet 4.6", { inputTokens: 3.00, cacheReadTokens: 0.30, cacheWriteTokens: 3.75, outputTokens: 15.00 }),
    pricing("Claude Opus 4.5", { inputTokens: 5.00, cacheReadTokens: 0.50, cacheWriteTokens: 6.25, outputTokens: 25.00 }),
    pricing("Claude Opus 4.6", { inputTokens: 5.00, cacheReadTokens: 0.50, cacheWriteTokens: 6.25, outputTokens: 25.00 }),
    pricing("Claude Opus 4.7", { inputTokens: 5.00, cacheReadTokens: 0.50, cacheWriteTokens: 6.25, outputTokens: 25.00 }),
    pricing("Claude Opus 4.8", { inputTokens: 5.00, cacheReadTokens: 0.50, cacheWriteTokens: 6.25, outputTokens: 25.00 }),
    pricing("Claude Fable 5", { inputTokens: 10.00, cacheReadTokens: 1.00, cacheWriteTokens: 12.50, outputTokens: 50.00 }),
    pricing("Gemini 2.5 Pro", { inputTokens: 1.25, cacheReadTokens: 0.125, outputTokens: 10.00 }),
    pricing("Gemini 3 Flash", { inputTokens: 0.50, cacheReadTokens: 0.05, outputTokens: 3.00 }),
    tieredPricing("Gemini 3.1 Pro", 200_000, {
        inputTokens: 2.00,
        cacheReadTokens: 0.20,
        outputTokens: 12.00,
    }, {
        inputTokens: 4.00,
        cacheReadTokens: 0.40,
        outputTokens: 18.00,
    }),
    pricing("Gemini 3.5 Flash", { inputTokens: 1.50, cacheReadTokens: 0.15, outputTokens: 9.00 }),
    pricing("Raptor mini", { inputTokens: 0.25, cacheReadTokens: 0.025, outputTokens: 2.00 }),
    pricing("MAI-Code-1-Flash", { inputTokens: 0.75, cacheReadTokens: 0.075, outputTokens: 4.50 }),
];

const PRICING_BY_MODEL = new Map(MODEL_PRICING.map((item) => [normalizeModelName(item.model), item]));

export function builtInModelRates(model, _tokenTotals = {}) {
    const record = PRICING_BY_MODEL.get(normalizeModelName(model));
    if (!record) {
        return undefined;
    }
    if (!record.tiers) {
        return record.rates;
    }
    // Retained session telemetry is aggregated across many requests. The
    // long-context threshold is request-scoped, so aggregate totals cannot
    // safely select a long-context tier.
    return record.tiers.default;
}

export function normalizeModelName(value) {
    return String(value ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

export function tokenClassKeys(tokens = {}) {
    return TOKEN_KEYS.filter((key) => optNum(tokens?.[key]) > 0);
}

export function usdPerMillionToNanoPerToken(usdPerMillion) {
    const usd = optNum(usdPerMillion);
    return usd === undefined ? undefined : usd / BILLING.usdPerAiCredit * BILLING.nanoAiuPerAiCredit / MILLION;
}

function pricing(model, usdPerMillion) {
    return { model, rates: nanoRates(usdPerMillion) };
}

function tieredPricing(model, threshold, defaultUsdPerMillion, longUsdPerMillion) {
    return {
        model,
        threshold,
        tiers: {
            default: nanoRates(defaultUsdPerMillion),
            long: nanoRates(longUsdPerMillion),
        },
    };
}

function nanoRates(usdPerMillion) {
    return Object.fromEntries(Object.entries(usdPerMillion)
        .map(([key, value]) => [key, usdPerMillionToNanoPerToken(value)])
        .filter(([, value]) => value !== undefined));
}
