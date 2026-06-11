import test from "node:test";
import assert from "node:assert/strict";

import { BILLING, STYLE } from "../../src/config.mjs";
import { formatAmount, formatDuration, formatTokenCount, paint, renderFormat, timestampMs } from "../../src/render/format.mjs";

test("formatAmount renders each display unit", () => {
    assert.equal(formatAmount(1, "gbp"), "£0.74");
    assert.equal(formatAmount(1, "usd"), "$1.00");
    assert.equal(formatAmount(1, "credits"), "100.00cr");
    assert.equal(formatAmount(1, "usd", { signed: true, precision: 1 }), "+$1.0");
    assert.equal(formatAmount(undefined, "gbp"), "£0.00");
});

test("formatAmount can round down to the displayed precision", () => {
    assert.equal(formatAmount(0.09 / BILLING.gbpPerUsd, "gbp", { precision: 1, rounding: "down" }), "£0.0");
    assert.equal(formatAmount(0.10 / BILLING.gbpPerUsd, "gbp", { precision: 1, rounding: "down" }), "£0.1");
    assert.equal(formatAmount(1.99, "usd", { precision: 0, rounding: "down" }), "$1");
});

test("formatDuration keeps terminal output compact", () => {
    assert.equal(formatDuration(1234), "1.2s");
    assert.equal(formatDuration(120_000), "2min");
    assert.equal(formatDuration(185_000), "3min 5s");
    assert.equal(formatDuration(20 * 60 * 1000), "20m");
    assert.equal(formatDuration(62 * 60 * 1000), "1hr 2m");
    assert.equal(formatDuration(-1000), "0s");
});

test("formatTokenCount renders compact counts with fallbacks", () => {
    assert.equal(formatTokenCount(undefined, { fallback: "?" }), "?");
    assert.equal(formatTokenCount(999), "999");
    assert.equal(formatTokenCount(1_234), "1k");
    assert.equal(formatTokenCount(1_500_000), "1.5m");
    assert.equal(formatTokenCount(-10), "0");
});

test("timestampMs parses runtime timestamps safely", () => {
    assert.equal(timestampMs("2026-01-01T00:00:00.000Z"), Date.UTC(2026, 0, 1));
    assert.equal(timestampMs("not a date"), undefined);
    assert.equal(timestampMs(undefined), undefined);
});

test("paint applies ANSI styles only when enabled and text is present", () => {
    assert.equal(paint("Total", STYLE.total, false), "Total");
    assert.equal(paint("Total", STYLE.total, true), `${STYLE.total}Total${STYLE.reset}`);
    assert.equal(paint("", STYLE.total, true), "");
});

test("renderFormat replaces known placeholders and preserves unknown ones", () => {
    assert.equal(renderFormat("{known} {missing}", { known: "ok" }, false, "fallback"), "ok {missing}");
    assert.equal(renderFormat("   ", { known: "ok" }, false, "fallback"), "fallback");
});

test("renderFormat strips the cache-write prefix when the token is empty", () => {
    assert.equal(
        renderFormat("r: {cache_read} w: {cache_write}", { cache_read: "90%", cache_write: "" }, false, "fallback"),
        "r: 90%",
    );
});
