// Formatting primitives for terminal output and user-defined templates.
// This module owns color, clock, duration, amount, and placeholder rendering so
// render/summary.mjs can focus on the cost-specific token contract.

import { BILLING, STYLE } from "../config.mjs";
import { num, optNum } from "../math.mjs";

const FORMAT_TOKEN_PATTERN = /\{([a-z0-9_]+)\}/g;

// Renders a user format string by replacing known placeholders.
export function renderFormat(format, tokens, color, fallback) {
    const template = parseFormat(format) ?? fallback;
    const parts = [];
    let index = 0;
    for (const match of template.matchAll(FORMAT_TOKEN_PATTERN)) {
        const token = tokens[match[1]];
        parts.push(paint(literalBeforeToken(template, index, match, token), STYLE.text, color));
        parts.push(token ?? paint(match[0], STYLE.cache, color));
        index = match.index + match[0].length;
    }
    parts.push(paint(template.slice(index), STYLE.text, color));
    return parts.join("");
}

// Wraps text in ANSI color only when color output is enabled.
export function paint(text, color, enabled) {
    return enabled && text ? `${color}${text}${STYLE.reset}` : text;
}

// Formats a ratio as a whole-number percentage.
export function formatPercent(value) {
    return `${Math.round(num(value))}%`;
}

// Formats token counts compactly for statusline width.
export function formatTokenCount(value, { fallback = "0" } = {}) {
    const rawTokens = optNum(value);
    if (rawTokens === undefined) {
        return fallback;
    }

    const tokens = Math.max(0, Math.round(rawTokens));
    if (tokens >= 1_000_000) {
        return `${trimDecimal((tokens / 1_000_000).toFixed(1))}m`;
    }
    if (tokens >= 1_000) {
        return `${Math.round(tokens / 1_000)}k`;
    }
    return String(tokens);
}

// Parses runtime timestamps into milliseconds.
export function timestampMs(value) {
    const timestamp = Date.parse(value ?? "");
    return Number.isFinite(timestamp) ? timestamp : undefined;
}

// Formats a timestamp as a local HH:MM clock value.
export function formatClock(value) {
    const date = new Date(value);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// Formats elapsed milliseconds for compact terminal display.
export function formatDuration(ms) {
    const seconds = Math.max(0, num(ms) / 1000);
    if (seconds < 60) {
        return `${trimDecimal(seconds.toFixed(1))}s`;
    }
    if (seconds < 300) {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = Math.round(seconds % 60);
        return remainingSeconds ? `${minutes}min ${remainingSeconds}s` : `${minutes}min`;
    }

    const totalMinutes = Math.round(seconds / 60);
    if (totalMinutes < 60) {
        return `${totalMinutes}m`;
    }

    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}hr${hours === 1 ? "" : "s"}${minutes ? ` ${minutes}m` : ""}`;
}

// Formats a USD value in the configured display unit.
export function formatAmount(usdValue, unit, { signed = false, precision = 2, rounding = "nearest" } = {}) {
    const value = optNum(usdValue) ?? 0;
    const body = formatAmountBody(value, unit, precision, rounding);
    return signed ? `+${body}` : body;
}

// Normalizes user-defined format strings.
export function parseFormat(value) {
    const format = String(value ?? "").replace(/\s+/g, " ").trim();
    return format || null;
}

// Drops a trailing ".0" so values like "1.0s" read as "1s".
function trimDecimal(value) {
    return value.replace(/\.0$/, "");
}

// Literal text before a token, trimming a dangling label for empty tokens.
function literalBeforeToken(template, index, match, token) {
    const literal = template.slice(index, match.index);
    return token === "" ? stripEmptyTokenPrefix(literal, match[1]) : literal;
}

// Renders the numeric body in the configured display unit.
function formatAmountBody(value, unit, precision, rounding) {
    if (unit === "credits") {
        return `${formatDecimal(value / BILLING.usdPerAiCredit, precision, rounding)}cr`;
    }
    if (unit === "usd") {
        return `$${formatDecimal(value, precision, rounding)}`;
    }
    return `£${formatDecimal(value * BILLING.gbpPerUsd, precision, rounding)}`;
}

// Formats decimals with an explicit rounding policy. The tiny epsilon prevents
// floating-point representation from holding a value below its exact threshold.
function formatDecimal(value, precision, rounding) {
    const digits = Math.max(0, Math.trunc(num(precision)));
    if (rounding !== "down") {
        return value.toFixed(digits);
    }
    const factor = 10 ** digits;
    const adjusted = Math.floor((value + 1e-12) * factor) / factor;
    return adjusted.toFixed(digits);
}

// Removes a now-empty "w:" cache-write label when its token resolved to nothing.
function stripEmptyTokenPrefix(literal, token) {
    return token === "cache_write" ? literal.replace(/\s*w:\s*$/i, "") : literal;
}
