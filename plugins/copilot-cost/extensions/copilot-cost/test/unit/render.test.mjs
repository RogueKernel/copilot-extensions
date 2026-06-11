import test from "node:test";
import assert from "node:assert/strict";

import { ANSI, DISPLAY, STYLE } from "../../src/config.mjs";
import { renderSummary } from "../../src/render/summary.mjs";

const sampleCost = {
    totalUsd: 1,
    sessionUsd: 1.5,
    lastNanoAiu: 2_000_000_000,
    lastDurationMs: 1234,
    lastEndedAt: Date.UTC(2026, 0, 1, 12, 3),
    contextTokens: 100000,
    contextTokenLimit: 200000,
    cacheReadPercent: 95,
    cacheWritePercent: 10,
    hasCacheWrite: true,
    inputNanoPerToken: 1000,
    cacheReadNanoPerToken: 100,
    cacheWriteNanoPerToken: 1250,
};

test("renders default after-message groups", () => {
    const output = renderSummary(sampleCost, { unit: "gbp", color: false, format: DISPLAY.defaultMessageFormat });

    assert.match(output, /^\[\d\d:\d\d\] \+£0\.01 in 1\.2s · Next >= \[£0\.00 - £0\.00\] · Cache 95% read, 10% write$/);
});

test("renders default footer groups", () => {
    const output = renderSummary({
        ...sampleCost,
        totalUsd: 1,
    }, { unit: "gbp", color: false });

    assert.match(output, /^Total £0\.74 · Ctx 50% \(100k\/200k\) · Sess £1\.1 · 24h £0 · 7d £0 · 30d £0$/);
});

test("renders cumulative session total and rolling cost windows", () => {
    const output = renderSummary({
        sessionUsd: 1.25,
        window24hUsd: 2,
        window7dUsd: 3,
        window30dUsd: 4,
    }, { unit: "usd", color: false, format: "{windows_group} {sess_cost}/{cost_24h}/{cost_7d}/{cost_30d}" });

    assert.equal(output, "Sess $1.2 · 24h $2 · 7d $3 · 30d $4 $1.2/$2/$3/$4");
});

test("renders group placeholders as labelled segments and value placeholders as bare values", () => {
    const output = renderSummary(sampleCost, {
        unit: "gbp",
        color: false,
        format: "{message_group} | {msg_cost}/{msg_time} | {total_group} | {cost}",
    });

    assert.equal(output, "+£0.01 in 1.2s | +£0.01/1.2s | Total £0.74 | £0.74");
});

test("removes dangling cache-write label when cache write is absent", () => {
    const output = renderSummary({ totalUsd: 0, cacheReadPercent: 0 }, { color: false, format: DISPLAY.defaultMessageFormat });

    assert.equal(output.includes("write"), false);
    assert.match(output, /Cache 0% read$/);
});

test("renders every user-visible format token", () => {
    assert.equal(new Set(DISPLAY.formatTokens).size, DISPLAY.formatTokens.length);

    const format = DISPLAY.formatTokens.join(" ");
    const output = renderSummary(sampleCost, { unit: "usd", color: false, format });

    for (const token of DISPLAY.formatTokens) {
        assert.equal(output.includes(token), false, `${token} was not rendered`);
    }
});

test("colors default groups with muted ANSI styles", () => {
    const message = renderSummary(sampleCost, { unit: "gbp", color: true, format: DISPLAY.defaultMessageFormat });
    const footer = renderSummary(sampleCost, { unit: "gbp", color: true, format: DISPLAY.defaultFooterFormat });

    assert.match(message, new RegExp(escapeRegExp(`${STYLE.text}12:03${STYLE.reset}`)));
    assert.match(message, new RegExp(escapeRegExp(`${STYLE.last}+£0.01 in 1.2s${STYLE.reset}`)));
    assert.match(message, new RegExp(escapeRegExp(`${STYLE.next}Next >= [£0.00 - £0.00]${STYLE.reset}`)));
    assert.match(message, new RegExp(escapeRegExp(`${STYLE.cache}Cache 95% read, 10% write${STYLE.reset}`)));
    assert.match(footer, new RegExp(escapeRegExp(`${STYLE.total}Total £0.74${STYLE.reset}`)));
    assert.match(footer, new RegExp(escapeRegExp(`${STYLE.context}Ctx 50% (100k/200k)${STYLE.reset}`)));
    assert.match(footer, new RegExp(escapeRegExp(`${STYLE.windows}Sess £1.1 · 24h £0 · 7d £0 · 30d £0${STYLE.reset}`)));
});

test("uses distinct colors for each rendered group", () => {
    const groupStyles = [STYLE.text, STYLE.last, STYLE.next, STYLE.cache, STYLE.total, STYLE.context, STYLE.windows];

    assert.equal(new Set(groupStyles).size, groupStyles.length);
    assert.equal(STYLE.next, ANSI.powderBlue);
    assert.equal(STYLE.total, ANSI.skyBlue);
    assert.equal(STYLE.context, ANSI.sand);
    assert.equal(STYLE.windows, ANSI.lavender);
    assert.equal(STYLE.cache, ANSI.slate);
});

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
