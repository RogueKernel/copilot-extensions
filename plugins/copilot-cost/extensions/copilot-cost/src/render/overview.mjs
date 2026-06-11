// Renders the interactive /cost overview: a broader cost summary plus a
// compact activity grid backed by the local session ledger.

import { BILLING, HISTORY, STYLE } from "../config.mjs";
import { ledgerUsageEvents } from "../domain/session-ledger.mjs";
import { num, optNum } from "../math.mjs";
import { formatAmount, formatTokenCount, paint } from "./format.mjs";

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
        "Usage-based billing starts Jun 1, 2026.",
        "Earlier retained telemetry uses current usage-based rates when available.",
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
    const visibleStart = months.at(-1)?.at ?? startOfUtcMonth(stats.now);
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
    return Array.from({ length: 6 }, (_, index) => monthBlock(addUtcMonths(currentMonth, -index), byDay, earliestDataAt, now));
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
        return `${Math.min(999, Math.max(0, Math.round(usd / BILLING.usdPerAiCredit)))}c`;
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
    return `${prefix}${Math.min(999, Math.max(0, Math.round(num(value))))}`;
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
