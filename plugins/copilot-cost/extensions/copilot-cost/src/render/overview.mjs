// Renders the interactive /cost overview: a broader cost summary plus a
// compact activity grid backed by the local session ledger.

import { BILLING, HISTORY, STYLE } from "../config.mjs";
import {
    ledgerUsageEvents,
    normalizeLedger,
    SOURCE_ESTIMATED_TOKENS,
    SURFACE_CLI,
    SURFACE_VSCODE,
} from "../domain/session-ledger.mjs";
import { num, optNum } from "../math.mjs";
import { formatAmount, formatTokenCount, paint } from "./format.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version: PLUGIN_VERSION } = require("../../package.json");

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const GRID_CELL_WIDTH = 4;
const MONTH_BLOCK_WEEK_COLUMNS = 6;
const MONTH_BLOCK_WIDTH = (MONTH_BLOCK_WEEK_COLUMNS * GRID_CELL_WIDTH) + MONTH_BLOCK_WEEK_COLUMNS + 1;
const TABLE_VALUE_RULE_WIDTH = 48;
const SECTION_RULE_MIN_WIDTH = 64;
const GRID_STYLES = [STYLE.text, STYLE.costLow, STYLE.costMedium, STYLE.costHigh, STYLE.costVeryHigh, STYLE.costCritical];
const GRID_BG_STYLES = [STYLE.costZeroBg, STYLE.costLowBg, STYLE.costMediumBg, STYLE.costHighBg, STYLE.costVeryHighBg, STYLE.costCriticalBg];

export function renderCostOverview({
    ledger = {},
    state = {},
    settings = {},
    now = Date.now(),
    color = true,
    columns = terminalColumns(),
    pluginVersion = PLUGIN_VERSION,
} = {}) {
    const unit = settings.unit;
    const stats = overviewStats({ ledger, state, now });
    const width = outputColumns(columns);
    return [
        "Cost overview",
        "",
        renderTopStats(stats, unit, color, width),
        "",
        renderActivity(stats, unit, color, width),
        "",
        renderDiagnostics(stats, unit, color),
        "",
        "Usage-based billing starts Jun 1, 2026.",
        "Earlier retained telemetry uses current usage-based rates when available.",
        "",
        `copilot-cost v${pluginVersion}`,
    ].filter((line) => line !== null).join("\n");
}

export function overviewStats({ ledger = {}, state = {}, now = Date.now() } = {}) {
    const events = ledgerUsageEvents(ledger, now, { includePreCredit: true });
    const chargedEvents = events.filter((event) => event.at >= HISTORY.moneyPricingStartedAt);
    const equivalentEvents = events.filter((event) => event.at < HISTORY.moneyPricingStartedAt);
    const buckets = dailyBuckets(events, now, HISTORY.retentionDays);
    const activeSessionIds = new Set(events.map((event) => event.id));
    const tokens = tokenTotalsForSessions(ledger, activeSessionIds);
    const peak = peakBucket(buckets);
    const earliestDataAt = earliestEventDay(events);
    const coverageDays = coverageDayCount(earliestDataAt, now);
    const total180dUsd = sumUsd(events);
    const avgDailyUsd = coverageDays > 0 ? total180dUsd / coverageDays : 0;

    return {
        now,
        events,
        buckets,
        activeSessions: activeSessionIds.size,
        earliestDataAt,
        coverageDays,
        avgDailyUsd,
        avgMonthlyUsd: avgDailyUsd * 30.4375,
        forecast7dUsd: avgDailyUsd * 7,
        forecast30dUsd: avgDailyUsd * 30,
        avgSessionUsd: activeSessionIds.size > 0 ? total180dUsd / activeSessionIds.size : undefined,
        total180dUsd,
        chargedSincePricingUsd: sumUsd(chargedEvents),
        equivalentBeforePricingUsd: sumUsd(equivalentEvents),
        window24hUsd: sumSince(events, now - DAY_MS),
        window7dUsd: sumSince(events, now - 7 * DAY_MS),
        window30dUsd: sumSince(events, now - 30 * DAY_MS),
        window60dUsd: sumSince(events, now - 60 * DAY_MS),
        window90dUsd: sumSince(events, now - 90 * DAY_MS),
        window180dUsd: sumUsd(events),
        monthlyCosts: monthlyCosts(events, now, 5, earliestDataAt),
        conversationUsd: optNum(state.totalUsd),
        sessionUsd: optNum(state.sessionUsd),
        peakDayUsd: peak.usd,
        peakDayAt: peak.at,
        tokens,
        modelBreakdown: modelBreakdown(ledger, activeSessionIds),
        surfaceBreakdown: surfaceBreakdown(ledger, events),
        diagnostics: diagnosticStats(ledger, now),
    };
}

function renderTopStats(stats, unit, color, width) {
    const compact = width < 90;
    const spendLines = statTable([
        ["Conversation", formatAmount(stats.conversationUsd, unit), STYLE.total],
        ["Copilot session", formatAmount(stats.sessionUsd, unit), STYLE.windows],
        ["Local sessions", String(stats.activeSessions), STYLE.next],
        ["Since Jun 1, 2026", formatAmount(stats.chargedSincePricingUsd, unit), STYLE.last],
        ["Before Jun 1, 2026", `${formatAmount(stats.equivalentBeforePricingUsd, unit)} (est. under current usage-based model)`, STYLE.next],
        ["Peak day", peakLabel(stats, unit), STYLE.cacheWarning],
        ["Data starts", stats.earliestDataAt === undefined ? "no retained cost data" : formatDate(stats.earliestDataAt), STYLE.context],
        ["Tokens", tokenSummary(stats), STYLE.context],
    ], color);
    const rangeLines = rangeRows(stats, unit, color, compact ? 2 : 3);
    const monthlyLines = monthlyRows(stats.monthlyCosts, unit, color, compact ? 1 : 2);
    const analysisLines = statTable([
        ["Data from", stats.earliestDataAt === undefined ? "no retained cost data" : `${formatDate(stats.earliestDataAt)} (${stats.coverageDays}d)`, STYLE.context],
        ["Avg/day", formatAmount(stats.avgDailyUsd, unit), STYLE.windows],
        ["Avg/mo", `${formatAmount(stats.avgMonthlyUsd, unit)} / 30d equiv`, STYLE.windows],
        ["Forecast 7d", formatAmount(stats.forecast7dUsd, unit), STYLE.cacheWarning],
        ["Forecast 30d", formatAmount(stats.forecast30dUsd, unit), STYLE.cacheWarning],
        ["Avg/session", stats.avgSessionUsd === undefined ? "n/a" : formatAmount(stats.avgSessionUsd, unit), STYLE.next],
        ["Surfaces", surfaceSummary(stats.surfaceBreakdown, unit, color), STYLE.context],
        ["Models", modelSummary(stats.modelBreakdown, unit, color, compact ? 1 : 3), STYLE.total],
    ], color);

    return [
        ...sectionBlock("Spend", spendLines, color),
        "",
        ...sectionBlock("Ranges", rangeLines, color),
        "",
        ...sectionBlock("Monthly", monthlyLines, color),
        "",
        ...sectionBlock("Analysis", analysisLines, color),
    ].join("\n");
}

function tokenSummary(stats) {
    const tokens = stats.tokens;
    const total = totalTokens(tokens);
    if (total <= 0) {
        return "not enough local session detail yet";
    }
    return `${formatTokenCount(total)} total (${formatTokenCount(tokens.cacheReadTokens)} cached, ${formatTokenCount(tokens.reasoningTokens)} reasoning)`;
}

function renderActivity(stats, unit, color, width) {
    const months = activityMonths(stats.buckets, stats.now, stats.earliestDataAt);
    const monthsPerRow = width < 104 ? 2 : 3;
    const visibleStart = months[0]?.at ?? startOfUtcMonth(stats.now);
    const visibleEnd = startOfUtcDay(stats.now) + DAY_MS;
    const visibleRecords = stats.events.filter((event) => event.at >= visibleStart && event.at < visibleEnd).length;
    const topDays = stats.buckets.filter((bucket) => bucket.usd > 0)
        .sort((left, right) => right.usd - left.usd)
        .slice(0, 3);
    return [
        `Cost calendar · six months · ${visibleRecords} visible records from ${HISTORY.retentionDays}d retention`,
        ...monthRows(months, unit, color, monthsPerRow),
        ...costLegend(unit, color, width),
        topDays.length ? `Top days: ${topDays.map((bucket) => dayCost(bucket, unit, color)).join(" · ")}` : "Top days: no retained cost records",
    ].join("\n");
}

function renderDiagnostics(stats, unit, color) {
    const diagnostics = stats.diagnostics;
    return [
        ...sectionBlock("Diagnostics", [
            ...statTable([
                ["Sessions found", `${diagnostics.totalSessions} total (${diagnostics.cliSessions} CLI, ${diagnostics.vscodeSessions} VS Code)`, STYLE.context],
            ], color),
            "",
            ...diagnosticRows(diagnostics.methods, unit, color),
        ], color),
    ].join("\n");
}

function monthRows(months, unit, color, monthsPerRow) {
    return chunk(months, monthsPerRow).flatMap((row) => {
        const border = monthBorder();
        return [
            `   ${row.map((month) => monthHeader(month, unit, color)).join("  ")}`.trimEnd(),
            `   ${row.map(() => border).join("  ")}`.trimEnd(),
            ...WEEKDAY_LABELS.map((label, index) => `${label} ${row.map((month) => monthRow(month, index, unit, color)).join("  ")}`.trimEnd()),
            `   ${row.map(() => border).join("  ")}`.trimEnd(),
        ];
    });
}

function monthRow(month, weekdayIndex, unit, color) {
    return `|${month.cells[weekdayIndex].map((bucket) => renderCell(bucket, month.earliestDataAt, unit, color)).join("|")}|`;
}

function renderCell(bucket, earliestDataAt, unit, color) {
    if (!bucket) {
        return paint(emptyCell(), STYLE.calendarEmptyBg, color);
    }
    if (earliestDataAt === undefined || bucket.at < earliestDataAt) {
        return paint(emptyCell(), STYLE.calendarEmptyBg, color);
    }
    if (bucket.usd <= 0) {
        return paint(padCell(noSpendCalendarAmount(unit)), STYLE.costZeroBg, color);
    }
    const level = activityLevel(bucket.usd, unit);
    const style = GRID_BG_STYLES[level];
    const label = calendarAmount(bucket.usd, unit);
    return paint(padCell(label), style, color);
}

function activityLevel(usd, unit) {
    if (usd <= 0) {
        return 0;
    }
    const thresholds = costThresholdsUsd(unit);
    for (let index = 0; index < thresholds.length; index += 1) {
        if (usd <= thresholds[index]) {
            return index + 1;
        }
    }
    return thresholds.length + 1;
}

function dailyBuckets(events, now, days) {
    const end = startOfUtcDay(now);
    const start = end - (days - 1) * DAY_MS;
    const costs = new Map();
    for (const event of events) {
        const day = startOfUtcDay(event.at);
        if (day < start || day > end) {
            continue;
        }
        costs.set(day, num(costs.get(day)) + num(event.usd));
    }
    return Array.from({ length: days }, (_, index) => {
        const at = start + index * DAY_MS;
        return { at, usd: num(costs.get(at)) };
    });
}

function activityMonths(buckets, now, earliestDataAt) {
    const byDay = new Map(buckets.map((bucket) => [bucket.at, bucket]));
    const currentMonth = startOfUtcMonth(now);
    return Array.from({ length: 6 }, (_, index) => monthBlock(addUtcMonths(currentMonth, index - 5), byDay, earliestDataAt, now));
}

function monthBlock(monthAt, byDay, earliestDataAt, now) {
    const cells = Array.from({ length: 7 }, () => Array.from({ length: MONTH_BLOCK_WEEK_COLUMNS }, () => null));
    const nextMonth = addUtcMonths(monthAt, 1);
    let usd = 0;
    for (let at = monthAt; at < nextMonth; at += DAY_MS) {
        const bucket = byDay.get(at);
        if (!bucket) {
            continue;
        }
        usd += num(bucket.usd);
        const slot = mondayIndex(monthAt) + new Date(at).getUTCDate() - 1;
        const week = Math.floor(slot / 7);
        if (week < MONTH_BLOCK_WEEK_COLUMNS) {
            cells[slot % 7][week] = bucket;
        }
    }
    return {
        at: monthAt,
        earliestDataAt,
        usd,
        avgDailyUsd: monthlyAverageUsd(usd, monthAt, earliestDataAt, now),
        cells,
    };
}

function monthlyCosts(events, now, count, earliestDataAt) {
    const currentMonth = startOfUtcMonth(now);
    return Array.from({ length: count }, (_, index) => {
        const at = addUtcMonths(currentMonth, -index);
        const next = addUtcMonths(at, 1);
        return {
            at,
            label: formatMonthYear(at),
            usd: events
                .filter((event) => event.at >= at && event.at < next)
                .reduce((sum, event) => sum + num(event.usd), 0),
            avgDailyUsd: monthlyAverageUsd(events
                .filter((event) => event.at >= at && event.at < next)
                .reduce((sum, event) => sum + num(event.usd), 0), at, earliestDataAt, now),
        };
    });
}

function peakBucket(buckets) {
    return buckets.reduce((peak, bucket) => bucket.usd > peak.usd ? bucket : peak, { at: undefined, usd: 0 });
}

function sectionBlock(title, lines, color) {
    return [sectionTitle(title, sectionWidth(title, lines), color), ...lines];
}

function sectionWidth(title, lines) {
    return Math.max(SECTION_RULE_MIN_WIDTH, title.length + 12, ...lines.map((line) => visibleLength(line)));
}

function sectionTitle(title, width, color) {
    const prefix = `+--[ ${title} ]`;
    const suffix = "+";
    const ruleWidth = Math.max(3, width - prefix.length - suffix.length);
    return paint(`${prefix}${"-".repeat(ruleWidth)}${suffix}`, STYLE.heading, color);
}

function visibleLength(value) {
    return String(value).replace(/\x1b\[[0-9;]*m/g, "").length;
}

function terminalColumns() {
    return Number(process?.env?.COLUMNS) || Number(process?.stdout?.columns) || 120;
}

function outputColumns(columns) {
    return Number.isFinite(Number(columns)) && Number(columns) > 0 ? Number(columns) : 120;
}

function statTable(rows, color) {
    const labelWidth = Math.max(...rows.map(([label]) => label.length));
    const valueWidth = Math.min(TABLE_VALUE_RULE_WIDTH, Math.max(5, ...rows.map(([, value]) => value.length)));
    const rendered = rows.map(([label, value, style]) => `  ${paint(label.padEnd(labelWidth), STYLE.label, color)} | ${paint(value, style, color)}`);
    if (rows.length === 1) {
        return rendered;
    }
    return [
        `  ${paint("Metric".padEnd(labelWidth), STYLE.heading, color)} | ${paint("Value", STYLE.heading, color)}`,
        `  ${"-".repeat(labelWidth)}-+-${"-".repeat(valueWidth)}`,
        ...rendered,
    ];
}

function gridTable(entries, { columns, headers, styles = [], color }) {
    const widths = headers.map((header, index) => Math.max(header.length, ...entries.map((entry) => String(entry[index]).length)));
    const header = headers.map((value, index) => paint(String(value).padEnd(widths[index]), STYLE.heading, color)).join(" | ");
    const divider = widths.map((width) => "-".repeat(width)).join("-+-");
    return [
        `  ${Array.from({ length: columns }, () => header).join("  ||  ")}`,
        `  ${Array.from({ length: columns }, () => divider).join("--++--")}`,
        ...chunk(entries, columns).map((row) => `  ${row.map((entry) => tableSegment(entry, widths, styles, headers.length, color)).join("  ||  ")}`),
    ];
}

function tableSegment(entry, widths, styles, valueCount, color) {
    const rowStyle = entry[valueCount];
    return entry.slice(0, valueCount).map((value, index) => {
        const text = String(value).padEnd(widths[index]);
        return paint(text, styles[index] ?? (index === 0 ? STYLE.label : rowStyle), color);
    }).join(" | ");
}

function rangeRows(stats, unit, color, columns) {
    return gridTable([
        ["24h", formatAmount(stats.window24hUsd, unit), STYLE.windows],
        ["7d", formatAmount(stats.window7dUsd, unit), STYLE.windows],
        ["30d", formatAmount(stats.window30dUsd, unit), STYLE.windows],
        ["60d", formatAmount(stats.window60dUsd, unit), STYLE.windows],
        ["90d", formatAmount(stats.window90dUsd, unit), STYLE.windows],
        ["180d", formatAmount(stats.window180dUsd, unit), STYLE.total],
    ], {
        columns,
        headers: ["Range", "Total"],
        styles: [STYLE.label, undefined],
        color,
    });
}

function monthlyRows(months, unit, color, columns) {
    return gridTable(months.map((month) => [
        month.label,
        formatAmount(month.usd, unit),
        formatAmount(month.avgDailyUsd, unit),
        STYLE.windows,
    ]), {
        columns,
        headers: ["Month", "Total", "Avg/day"],
        styles: [STYLE.label, undefined, undefined],
        color,
    });
}

function peakLabel(stats, unit) {
    if (stats.peakDayUsd <= 0 || stats.peakDayAt === undefined) {
        return formatAmount(0, unit);
    }
    return `${formatDate(stats.peakDayAt)} ${formatAmount(stats.peakDayUsd, unit)}`;
}

function dayCost(bucket, unit, color) {
    const level = activityLevel(bucket.usd, unit);
    const label = `${formatDate(bucket.at)} ${formatAmount(bucket.usd, unit)}`;
    return paint(label, GRID_STYLES[level], color);
}

function calendarAmount(usd, unit) {
    if (unit === "credits") {
        return compactCreditCalendarAmount(usd / BILLING.usdPerAiCredit);
    }
    if (unit === "usd") {
        return compactCalendarAmount(usd, "$");
    }
    return compactCalendarAmount(usd * BILLING.gbpPerUsd, "£");
}

function noSpendCalendarAmount(unit) {
    if (unit === "credits") {
        return "-c";
    }
    if (unit === "usd") {
        return "$-";
    }
    return "£-";
}

function compactCalendarAmount(value, prefix) {
    const amount = Math.max(0, num(value));
    const rounded = Math.round(amount);
    if (rounded < 1000) {
        return `${prefix}${rounded}`;
    }
    if (rounded < 10_000) {
        return `${prefix}${oneDecimal(Math.min(9.9, Math.round(amount / 100) / 10))}`;
    }
    if (rounded < 99_500) {
        return `${prefix}${Math.round(amount / 1000)}k`;
    }
    if (rounded < 999_500) {
        return `${prefix}${decimalWithoutLeadingZero(amount / 1_000_000)}m`;
    }
    if (rounded < 99_500_000) {
        return `${prefix}${Math.round(amount / 1_000_000)}m`;
    }
    if (rounded < 999_500_000) {
        return `${prefix}${decimalWithoutLeadingZero(amount / 1_000_000_000)}b`;
    }
    return `${prefix}${Math.round(amount / 1_000_000_000)}b`;
}

function compactCreditCalendarAmount(value) {
    const amount = Math.max(0, num(value));
    const rounded = Math.round(amount);
    if (rounded < 1000) {
        return `${rounded}c`;
    }
    if (rounded < 10_000) {
        return `${oneDecimal(Math.min(9.9, Math.round(amount / 100) / 10))}k`;
    }
    if (rounded < 99_500) {
        return `${Math.round(amount / 1000)}kc`;
    }
    if (rounded < 999_500) {
        return `${decimalWithoutLeadingZero(amount / 1_000_000)}mc`;
    }
    if (rounded < 99_500_000) {
        return `${Math.round(amount / 1_000_000)}mc`;
    }
    if (rounded < 999_500_000) {
        return `${decimalWithoutLeadingZero(amount / 1_000_000_000)}bc`;
    }
    return `${Math.round(amount / 1_000_000_000)}bc`;
}

function oneDecimal(value) {
    const fixed = value.toFixed(1);
    return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

function decimalWithoutLeadingZero(value) {
    return oneDecimal(Math.max(0.1, Math.min(9.9, Math.round(value * 10) / 10))).replace(/^0/, "");
}

function padCell(value) {
    return String(value).slice(0, GRID_CELL_WIDTH).padEnd(GRID_CELL_WIDTH, " ");
}

function emptyCell() {
    return " ".repeat(GRID_CELL_WIDTH);
}

function monthBorder() {
    return `+${Array.from({ length: MONTH_BLOCK_WEEK_COLUMNS }, () => "-".repeat(GRID_CELL_WIDTH)).join("+")}+`;
}

function monthHeader(month, unit, color) {
    const date = new Date(month.at);
    const label = `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} · ${formatAmount(month.usd, unit, { precision: 0 })} (~${formatAmount(month.avgDailyUsd, unit, { precision: 0 })}/day)`;
    return paint(centerLabel(label, MONTH_BLOCK_WIDTH), STYLE.heading, color);
}

function centerLabel(label, width) {
    const left = Math.floor((width - label.length) / 2);
    return `${" ".repeat(Math.max(0, left))}${label}`.padEnd(width, " ");
}

function costLegend(unit, color, width) {
    const thresholds = costThresholdsUsd(unit);
    const semantics = [
        `${paint(emptyCell(), STYLE.calendarEmptyBg, color)} = outside active range`,
        `${paint(padCell(noSpendCalendarAmount(unit)), STYLE.costZeroBg, color)} = no spend after data begins`,
    ];
    const ranges = [
        `${paint(padCell("val"), GRID_BG_STYLES[1], color)} <=${formatAmount(thresholds[0], unit, { precision: 0 })}`,
        `${paint(padCell("val"), GRID_BG_STYLES[2], color)} <=${formatAmount(thresholds[1], unit, { precision: 0 })}`,
        `${paint(padCell("val"), GRID_BG_STYLES[3], color)} <=${formatAmount(thresholds[2], unit, { precision: 0 })}`,
        `${paint(padCell("val"), GRID_BG_STYLES[4], color)} <=${formatAmount(thresholds[3], unit, { precision: 0 })}`,
        `${paint(padCell("val"), GRID_BG_STYLES[5], color)} >${formatAmount(thresholds[3], unit, { precision: 0 })}`,
    ];
    if (width < 90) {
        return [
            `Daily cost scale: ${semantics[0]}`,
            `                  ${semantics[1]}`,
            `Daily cost bands: ${ranges.slice(0, 3).join(" · ")}`,
            `                  ${ranges.slice(3).join(" · ")}`,
        ];
    }
    return [
        `Daily cost scale: ${semantics.join(" · ")}`,
        `Daily cost bands: ${ranges.join(" · ")}`,
    ];
}

function monthlyAverageUsd(usd, monthAt, earliestDataAt, now) {
    const days = monthCoverageDays(monthAt, earliestDataAt, now);
    return days > 0 ? usd / days : 0;
}

function monthCoverageDays(monthAt, earliestDataAt, now) {
    if (earliestDataAt === undefined) {
        return 0;
    }
    const start = Math.max(monthAt, earliestDataAt);
    const end = Math.min(addUtcMonths(monthAt, 1) - DAY_MS, startOfUtcDay(now));
    return end >= start ? Math.floor((end - start) / DAY_MS) + 1 : 0;
}

function costThresholdsUsd(unit) {
    if (unit === "gbp") {
        return [10, 25, 50, 100].map((value) => value / BILLING.gbpPerUsd);
    }
    if (unit === "credits") {
        return [1000, 2500, 5000, 10000].map((value) => value * BILLING.usdPerAiCredit);
    }
    return [10, 25, 50, 100];
}

function sumUsd(events) {
    return events.reduce((sum, event) => sum + num(event.usd), 0);
}

function sumSince(events, cutoff) {
    return events.filter((event) => event.at >= cutoff).reduce((sum, event) => sum + num(event.usd), 0);
}

function earliestEventDay(events) {
    if (!events.length) {
        return undefined;
    }
    return Math.min(...events.map((event) => startOfUtcDay(event.at)));
}

function coverageDayCount(earliestDataAt, now) {
    if (earliestDataAt === undefined) {
        return 0;
    }
    return Math.floor((startOfUtcDay(now) - earliestDataAt) / DAY_MS) + 1;
}

function tokenTotalsForSessions(ledger, ids) {
    const totals = {};
    for (const id of ids) {
        const session = ledger?.sessions?.[id];
        mergeTokens(totals, session?.tokenTotals);
    }
    return totals;
}

function modelBreakdown(ledger, ids) {
    const totals = new Map();
    for (const id of ids) {
        const session = ledger?.sessions?.[id];
        for (const [model, metrics] of Object.entries(session?.modelMetrics ?? {})) {
            const usd = optNum(metrics?.totalNanoAiu) === undefined ? 0 : metrics.totalNanoAiu / BILLING.nanoAiuPerAiCredit * BILLING.usdPerAiCredit;
            if (usd > 0) {
                totals.set(model, num(totals.get(model)) + usd);
            }
        }
    }
    const totalUsd = Array.from(totals.values()).reduce((sum, usd) => sum + usd, 0);
    return Array.from(totals.entries())
        .map(([model, usd]) => ({ model, usd, share: totalUsd > 0 ? usd / totalUsd : 0 }))
        .sort((left, right) => right.usd - left.usd)
        .slice(0, 3);
}

function surfaceBreakdown(ledger, events) {
    const totals = new Map([
        [SURFACE_CLI, { surface: SURFACE_CLI, sessions: new Set(), usd: 0 }],
        [SURFACE_VSCODE, { surface: SURFACE_VSCODE, sessions: new Set(), usd: 0 }],
    ]);
    for (const event of events) {
        const surface = sessionSurface(ledger?.sessions?.[event.id], event.id);
        const entry = totals.get(surface) ?? { surface, sessions: new Set(), usd: 0 };
        entry.sessions.add(event.id);
        entry.usd += num(event.usd);
        totals.set(surface, entry);
    }
    return Array.from(totals.values()).map((entry) => ({
        surface: entry.surface,
        sessionCount: entry.sessions.size,
        usd: entry.usd,
    }));
}

function sessionSurface(session, id) {
    if (session?.surface === SURFACE_VSCODE || id?.startsWith(`${SURFACE_VSCODE}:`)) {
        return SURFACE_VSCODE;
    }
    return SURFACE_CLI;
}

function surfaceSummary(surfaces, unit, color) {
    const labels = {
        [SURFACE_CLI]: "CLI",
        [SURFACE_VSCODE]: "VS Code",
    };
    return surfaces
        .filter((surface) => surface.sessionCount > 0 || surface.usd > 0)
        .map((surface) => `${labels[surface.surface] ?? surface.surface} ${paint(formatAmount(surface.usd, unit), STYLE.context, color)} / ${surface.sessionCount} ${plural(surface.sessionCount, "session")}`)
        .join(" · ") || "no retained cost data";
}

function diagnosticStats(ledger, now) {
    const normalized = normalizeLedger(ledger);
    const eventsBySession = new Map(ledgerUsageEvents(normalized, now, { includePreCredit: true }).map((event) => [event.id, event]));
    const sessions = Object.values(normalized.sessions).filter((session) => inRetainedWindow(session, now));
    const methods = new Map(DIAGNOSTIC_METHOD_ORDER.map((method) => [method, {
        method,
        sessions: 0,
        usd: 0,
    }]));

    let cliSessions = 0;
    let vscodeSessions = 0;

    for (const session of sessions) {
        const event = eventsBySession.get(session.id);
        const method = diagnosticMethod(session, event);
        const entry = methods.get(method) ?? { method, sessions: 0, usd: 0 };
        const usd = diagnosticUsd(session, event);
        entry.sessions += 1;
        entry.usd += usd;
        methods.set(method, entry);

        if (sessionSurface(session, session.id) === SURFACE_VSCODE) {
            vscodeSessions += 1;
        } else {
            cliSessions += 1;
        }
    }

    return {
        totalSessions: sessions.length,
        cliSessions,
        vscodeSessions,
        methods: Array.from(methods.values()).filter((method) => method.sessions > 0 || ALWAYS_SHOW_DIAGNOSTIC_METHODS.has(method.method)),
    };
}

const METHOD_CLOSED_AI_CREDITS = "closed_ai_credits";
const METHOD_OPEN_AI_CREDITS = "open_ai_credits";
const METHOD_AUTO_CLOSED_AI_CREDITS = "auto_closed_ai_credits";
const METHOD_CLOSED_TOKENS = "closed_tokens";
const METHOD_OPEN_TOKENS = "open_tokens";
const METHOD_AUTO_CLOSED_TOKENS = "auto_closed_tokens";

const DIAGNOSTIC_METHOD_ORDER = [
    METHOD_OPEN_AI_CREDITS,
    METHOD_OPEN_TOKENS,
    METHOD_CLOSED_AI_CREDITS,
    METHOD_CLOSED_TOKENS,
    METHOD_AUTO_CLOSED_AI_CREDITS,
    METHOD_AUTO_CLOSED_TOKENS,
];

const ALWAYS_SHOW_DIAGNOSTIC_METHODS = new Set([
    METHOD_AUTO_CLOSED_AI_CREDITS,
]);

const DIAGNOSTIC_METHOD_LABELS = {
    [METHOD_CLOSED_AI_CREDITS]: ["Closed [AI Cr]", "Exact"],
    [METHOD_OPEN_AI_CREDITS]: ["Open [AI Cr]", "Est. High"],
    [METHOD_AUTO_CLOSED_AI_CREDITS]: ["Stale [AI Cr]", "Est. High"],
    [METHOD_CLOSED_TOKENS]: ["Closed [Token]", "Estimate"],
    [METHOD_OPEN_TOKENS]: ["Open [Token]", "Est. Low"],
    [METHOD_AUTO_CLOSED_TOKENS]: ["Stale [Token]", "Est. Low"],
};

function diagnosticRows(methods, unit, color) {
    if (!methods.length) {
        return ["  No retained session records yet."];
    }
    return gridTable(methods.map((method) => {
        const [label, confidence] = DIAGNOSTIC_METHOD_LABELS[method.method] ?? [method.method, "unknown"];
        return [
            label,
            method.sessions,
            formatAmount(method.usd, unit),
            confidence,
            STYLE.context,
        ];
    }), {
        columns: 1,
        headers: ["Method", "Sessions", "Total", "Confidence"],
        styles: [STYLE.label, undefined, undefined, undefined],
        color,
    });
}

function diagnosticMethod(session, event) {
    if (session.state === "auto_closed") {
        return session.source !== SOURCE_ESTIMATED_TOKENS && hasObservedAiCreditTotal(session)
            ? METHOD_AUTO_CLOSED_AI_CREDITS
            : METHOD_AUTO_CLOSED_TOKENS;
    }

    const hasCost = num(event?.usd) > 0;
    if (!hasCost) {
        if (session.state === "open") {
            return hasObservedAiCreditTotal(session) || !hasSessionActivity(session) ? METHOD_OPEN_AI_CREDITS : METHOD_OPEN_TOKENS;
        }
        return hasSessionActivity(session) ? METHOD_CLOSED_TOKENS : METHOD_CLOSED_AI_CREDITS;
    }
    if (session.source === SOURCE_ESTIMATED_TOKENS || isPreCreditSession(session) || !hasObservedAiCreditTotal(session)) {
        return sessionStateMethod(session, {
            closed: METHOD_CLOSED_TOKENS,
            open: METHOD_OPEN_TOKENS,
            autoClosed: METHOD_AUTO_CLOSED_TOKENS,
        });
    }
    return sessionStateMethod(session, {
        closed: METHOD_CLOSED_AI_CREDITS,
        open: METHOD_OPEN_AI_CREDITS,
        autoClosed: METHOD_AUTO_CLOSED_AI_CREDITS,
    });
}

function diagnosticUsd(session, event) {
    return num(event?.usd);
}

function inRetainedWindow(session, now) {
    const at = bucketTimestamp(session);
    return at === undefined || (at >= now - HISTORY.retentionDays * DAY_MS && at <= now);
}

function bucketTimestamp(session) {
    return optNum(session.windowAt)
        ?? optNum(session.closedAt)
        ?? optNum(session.lastSeenAt)
        ?? optNum(session.lastUpdatedAt);
}

function isPreCreditSession(session) {
    const at = bucketTimestamp(session);
    return at !== undefined && at < HISTORY.moneyPricingStartedAt;
}

function hasObservedAiCreditTotal(session) {
    return optNum(session.totalNanoAiu) > 0 || sumModelMetricNanoAiu(session.modelMetrics) > 0;
}

function sumModelMetricNanoAiu(modelMetrics = {}) {
    return Object.values(modelMetrics).reduce((total, metrics) => total + num(metrics?.totalNanoAiu), 0);
}

function hasSessionActivity(session) {
    return totalTokens(session.tokenTotals) > 0
        || Object.keys(session.modelMetrics ?? {}).length > 0
        || optNum(session.usageNanoAiu) > 0
        || optNum(session.compactionNanoAiu) > 0
        || optNum(session.modelNanoAiu) > 0;
}

function sessionStateMethod(session, methods) {
    if (session.state === "closed" || isRoutineShutdown(session)) {
        return methods.closed;
    }
    if (session.state === "auto_closed") {
        return methods.autoClosed;
    }
    return methods.open;
}

function isRoutineShutdown(session) {
    return session.shutdownType === "routine";
}

function modelSummary(models, unit, color, maxModels = 3) {
    if (!models.length) {
        return "not enough local model detail yet";
    }
    const visible = models.slice(0, maxModels);
    const summary = visible
        .map((model) => `${model.model} ${paint(formatAmount(model.usd, unit), STYLE.total, color)} (${Math.round(model.share * 100)}%)`)
        .join(" · ");
    const hidden = models.length - visible.length;
    return hidden > 0 ? `${summary} +${hidden} more` : summary;
}

function plural(count, singular) {
    return count === 1 ? singular : `${singular}s`;
}

function mergeTokens(target, source = {}) {
    for (const key of ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens"]) {
        target[key] = num(target[key]) + num(source[key]);
    }
}

function totalTokens(tokens = {}) {
    return num(tokens.inputTokens)
        + num(tokens.cacheReadTokens)
        + num(tokens.cacheWriteTokens)
        + num(tokens.outputTokens)
        + num(tokens.reasoningTokens);
}

function chunk(values, size) {
    const rows = [];
    for (let index = 0; index < values.length; index += size) {
        rows.push(values.slice(index, index + size));
    }
    return rows;
}

function formatDate(timestamp) {
    const date = new Date(timestamp);
    return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

function formatMonthYear(timestamp) {
    const date = new Date(timestamp);
    return `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function mondayIndex(timestamp) {
    return (new Date(timestamp).getUTCDay() + 6) % 7;
}

function startOfUtcDay(timestamp) {
    const date = new Date(timestamp);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfUtcMonth(timestamp) {
    const date = new Date(timestamp);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function addUtcMonths(timestamp, months) {
    const date = new Date(timestamp);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1);
}
