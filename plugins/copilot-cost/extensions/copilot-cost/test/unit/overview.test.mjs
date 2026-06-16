import test from "node:test";
import assert from "node:assert/strict";

import { BILLING, HISTORY } from "../../src/config.mjs";
import { overviewStats, renderCostOverview } from "../../src/render/overview.mjs";

const day = 24 * 60 * 60 * 1000;

test("overview separates actual post-pricing cost from earlier equivalent cost", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const ledger = {
        sessions: {
            before: session("before", Date.UTC(2026, 4, 31, 12), 100_000_000_000, {
                outputTokens: 50,
            }, {
                "gpt-test": {
                    totalNanoAiu: 50_000_000_000,
                    tokenTotals: { outputTokens: 50 },
                },
            }),
            after: session("after", Date.UTC(2026, 5, 2, 12), 200_000_000_000, {
                inputTokens: 1000,
                cacheReadTokens: 500,
                reasoningTokens: 50,
            }, {
                "gpt-test": {
                    totalNanoAiu: 200_000_000_000,
                    tokenTotals: { outputTokens: 100 },
                },
            }),
            tooOld: session("tooOld", now - (HISTORY.retentionDays + 1) * day, 300_000_000_000),
        },
    };

    const stats = overviewStats({
        ledger,
        state: { totalUsd: 3.5, sessionUsd: 2.5 },
        now,
    });

    assert.equal(stats.total180dUsd, 3);
    assert.equal(stats.chargedSincePricingUsd, 2);
    assert.equal(stats.equivalentBeforePricingUsd, 1);
    assert.equal(stats.window60dUsd, 3);
    assert.equal(stats.window90dUsd, 3);
    assert.equal(stats.window180dUsd, 3);
    assert.equal(stats.earliestDataAt, Date.UTC(2026, 4, 31));
    assert.equal(stats.coverageDays, 11);
    assertApprox(stats.avgDailyUsd, 3 / 11);
    assertApprox(stats.forecast7dUsd, 21 / 11);
    assertApprox(stats.forecast30dUsd, 90 / 11);
    assert.equal(stats.avgSessionUsd, 1.5);
    assert.deepEqual(stats.monthlyCosts.map((month) => [month.label, month.usd]), [
        ["June 2026", 2],
        ["May 2026", 1],
        ["April 2026", 0],
        ["March 2026", 0],
        ["February 2026", 0],
    ]);
    assert.equal(stats.activeSessions, 2);
    assert.equal(stats.tokens.inputTokens, 1000);
    assert.equal(stats.tokens.cacheReadTokens, 500);
    assert.equal(stats.tokens.outputTokens, 50);
    assert.equal(stats.tokens.reasoningTokens, 50);
    assert.deepEqual(stats.modelBreakdown.map((model) => [model.model, model.usd, model.share]), [
        ["gpt-test", 2.5, 1],
    ]);
    assert.deepEqual(stats.surfaceBreakdown.map((surface) => [surface.surface, surface.sessionCount, surface.usd]), [
        ["cli", 2, 3],
        ["vscode", 0, 0],
    ]);
    assert.deepEqual(stats.diagnostics.methods.map((method) => [method.method, method.sessions, method.usd]), [
        ["closed_ai_credits", 1, 2],
        ["closed_tokens", 1, 1],
        ["auto_closed_ai_credits", 0, 0],
    ]);
});

test("overview renders a compact 180-day cost view", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const renderInput = {
        now,
        settings: { unit: "usd" },
        state: { totalUsd: 3.5, sessionUsd: 2.5 },
        ledger: {
            sessions: {
                before: session("before", Date.UTC(2026, 4, 31, 12), 999_000_000_000, {
                    outputTokens: 50,
                }, {
                    "gpt-test": {
                        totalNanoAiu: 999_000_000_000,
                        tokenTotals: { outputTokens: 50 },
                    },
                }),
                after: session("after", Date.UTC(2026, 5, 2, 12), 200_000_000_000, {
                    inputTokens: 1000,
                    cacheReadTokens: 500,
                    outputTokens: 250,
                }, {
                    "gpt-test": {
                        totalNanoAiu: 200_000_000_000,
                        tokenTotals: { outputTokens: 100 },
                    },
                }),
                high: session("high", Date.UTC(2026, 5, 3, 12), 11_000_000_000_000),
                uncosted: session("uncosted", Date.UTC(2026, 5, 4, 12), undefined, {
                    inputTokens: 100,
                    outputTokens: 10,
                }, {}, {
                    state: "open",
                    source: "none",
                    closedAt: undefined,
                    lastSeenAt: Date.UTC(2026, 5, 4, 12),
                }),
            },
        },
    };
    const output = renderCostOverview({ ...renderInput, color: false });
    const coloredOutput = renderCostOverview({ ...renderInput, color: true });
    const narrowOutput = renderCostOverview({ ...renderInput, color: false, columns: 80 });

    assert.match(output, /^Cost overview/);
    assert.match(output, /\+--\[ Spend \]-+\+/);
    assert.match(output, /Metric\s+\| Value/);
    assert.match(output, /-+\+-+/);
    assert.match(output, /Conversation\s+\|\s+\$3\.50/);
    assert.match(output, /Copilot session\s+\|\s+\$2\.50/);
    assert.match(output, /Local sessions\s+\|\s+3/);
    assert.match(output, /Since Jun 1, 2026\s+\|\s+\$112\.00/);
    assert.match(output, /Before Jun 1, 2026\s+\|\s+\$1\.00 \(est\. under current usage-based model\)/);
    assert.match(output, /Peak day\s+\|\s+Jun 3, 2026 \$110\.00/);
    assert.match(output, /Data starts\s+\|\s+May 31, 2026/);
    assert.match(output, /Tokens\s+\|\s+2k total \(500 cached, 0 reasoning\)/);
    assert.doesNotMatch(output, /== Usage-based billing ==/);
    assert.doesNotMatch(output, /Historical estimate/);
    assert.match(output, /\+--\[ Ranges \]-+\+/);
    assert.match(output, /Range\s+\| Total/);
    assert.match(output, /24h\s+\|\s+\$0\.00\s+\|\|\s+7d\s+\|\s+\$110\.00\s+\|\|\s+30d\s+\|\s+\$113\.00/);
    assert.match(output, /60d\s+\|\s+\$113\.00\s+\|\|\s+90d\s+\|\s+\$113\.00\s+\|\|\s+180d\s+\|\s+\$113\.00/);
    assert.doesNotMatch(output, /\b3mo\b|\b6mo\b|Pre-Jun equiv|Actual money/);
    assert.match(output, /\+--\[ Monthly \]-+\+/);
    assert.match(output, /Month\s+\| Total\s+\| Avg\/day/);
    assert.match(output, /June 2026\s+\|\s+\$112\.00\s+\|\s+\$11\.20\s+\|\|\s+May 2026\s+\|\s+\$1\.00\s+\|\s+\$1\.00/);
    assert.match(output, /April 2026\s+\|\s+\$0\.00\s+\|\s+\$0\.00\s+\|\|\s+March 2026\s+\|\s+\$0\.00\s+\|\s+\$0\.00/);
    assert.match(output, /February 2026\s+\|\s+\$0\.00\s+\|\s+\$0\.00/);
    assert.doesNotMatch(output, /January 2026\s+\|/);
    assert.match(output, /\+--\[ Analysis \]-+\+/);
    assert.match(output, /Data from\s+\|\s+May 31, 2026 \(11d\)/);
    assert.match(output, /Avg\/day\s+\|\s+\$10\.27/);
    assert.match(output, /Avg\/mo\s+\|\s+\$312\.68 \/ 30d equiv/);
    assert.match(output, /Forecast 7d\s+\|\s+\$71\.91/);
    assert.match(output, /Forecast 30d\s+\|\s+\$308\.18/);
    assert.match(output, /Avg\/session\s+\|\s+\$37\.67/);
    assert.match(output, /Surfaces\s+\|\s+CLI \$113\.00 \/ 3 sessions/);
    assert.match(output, /Models\s+\|\s+gpt-test \$11\.99 \(100%\)/);
    assert.match(output, /Cost calendar · six months · 3 visible records from 180d retention/);
    assert.match(output, /Jan 2026 · \$0 \(~\$0\/day\).*Feb 2026 · \$0 \(~\$0\/day\).*Mar 2026 · \$0 \(~\$0\/day\)/);
    assert.match(output, /Apr 2026 · \$0 \(~\$0\/day\).*May 2026 · \$1 \(~\$1\/day\).*Jun 2026 · \$112 \(~\$11\/day\)/);
    assert.doesNotMatch(output, /Dec 2025/);
    assert.match(output, /\+----\+----\+----\+----\+----\+----\+/);
    assert.match(output, /Mo .*?\|\$-\s+\|\$-\s+\|/);
    assert.match(output, /Tu .*?\|\$2\s+\|\$-\s+\|/);
    assert.match(output, /We .*?\|\$110\|\$-\s+\|/);
    assert.match(output, /Su .*?\|\$1\s+\|.*\|\$-\s+\|/);
    assert.doesNotMatch(output, /\|\s+\$0\|/);
    assert.doesNotMatch(output, /·{1,2} none/);
    assert.match(output, /Daily cost scale: .*outside active range.*\$-\s+= no spend after data begins/);
    assert.match(output, /Daily cost bands: .*<=\$10.*<=\$25.*<=\$50.*<=\$100.*>\$100/);
    assert.match(output, /Top days: Jun 3, 2026 \$110\.00 · Jun 2, 2026 \$2\.00 · May 31, 2026 \$1\.00/);
    assert.match(output, /\+--\[ Diagnostics \]-+\+/);
    assert.match(output, /Sessions found\s+\|\s+4 total \(4 CLI, 0 VS Code\)/);
    assert.doesNotMatch(output, /Costed sessions|Uncosted sessions/);
    assert.match(output, /Method\s+\| Sessions\s+\| Total\s+\| Confidence/);
    assert.match(output, /Open \[Token\]\s+\|\s+1\s+\|\s+\$0\.00\s+\|\s+Est\. Low/);
    assert.match(output, /Closed \[AI Cr\]\s+\|\s+2\s+\|\s+\$112\.00\s+\|\s+Exact/);
    assert.match(output, /Closed \[Token\]\s+\|\s+1\s+\|\s+\$1\.00\s+\|\s+Estimate/);
    assert.doesNotMatch(output, /No cost data/);
    assert.match(output, /Usage-based billing starts Jun 1, 2026/);
    assert.match(output, /copilot-cost v\d+\.\d+\.\d+$/);
    assert.match(coloredOutput, /\x1b\[97m\x1b\[48;5;88m\$110\x1b\[0m/);
    assert.match(coloredOutput, /\x1b\[38;5;250m\x1b\[48;5;238m\$-\s+\x1b\[0m/);
    assert.match(coloredOutput, /\x1b\[48;5;238m\s{4}\x1b\[0m/);
    assert.match(narrowOutput, /Jan 2026 · \$0 \(~\$0\/day\).*Feb 2026 · \$0 \(~\$0\/day\)/);
    assert.match(narrowOutput, /Mar 2026 · \$0 \(~\$0\/day\).*Apr 2026 · \$0 \(~\$0\/day\)/);
    assert.match(narrowOutput, /May 2026 · \$1 \(~\$1\/day\).*Jun 2026 · \$112 \(~\$11\/day\)/);

    for (const line of output.split("\n")) {
        assert.ok(stripAnsi(line).length <= 140, `calendar output should stay narrow: ${line}`);
    }
    for (const line of narrowOutput.split("\n")) {
        assert.ok(stripAnsi(line).length <= 80, `narrow overview should fit 80 columns: ${line}`);
    }
});

test("overview analysis breaks retained cost out by session surface", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const output = renderCostOverview({
        now,
        color: false,
        settings: { unit: "credits" },
        ledger: {
            sessions: {
                cli: session("cli", Date.UTC(2026, 5, 2, 12), 200_000_000_000),
                "vscode:root:workspace:session": session("vscode:root:workspace:session", Date.UTC(2026, 5, 3, 12), 300_000_000_000),
            },
        },
    });

    assert.match(output, /Surfaces\s+\|\s+CLI 200\.00cr \/ 1 session · VS Code 300\.00cr \/ 1 session/);
});

test("overview diagnostics show retained sessions by costing method and surface", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const output = renderCostOverview({
        now,
        color: false,
        settings: { unit: "usd" },
        ledger: {
            sessions: {
                shutdown: session("shutdown", Date.UTC(2026, 5, 2, 12), 100_000_000_000, {}, {
                    "gpt-test": {
                        totalNanoAiu: 100_000_000_000,
                        tokenTotals: { outputTokens: 10 },
                    },
                }),
                statusline: session("statusline", Date.UTC(2026, 5, 3, 12), 200_000_000_000, {}, {}, {
                    state: "open",
                    source: "statusline",
                    lastSeenAt: Date.UTC(2026, 5, 3, 12),
                }),
                cleanEstimate: session("cleanEstimate", Date.UTC(2026, 4, 31, 12), 300_000_000_000, {
                    outputTokens: 30,
                }, {
                    "gpt-test": {
                        totalNanoAiu: 300_000_000_000,
                        tokenTotals: { outputTokens: 30 },
                    },
                }),
                dirtyEstimate: session("dirtyEstimate", Date.UTC(2026, 4, 30, 12), 400_000_000_000, {}, {}, {
                    state: "auto_closed",
                    source: "estimated_tokens",
                    lastSeenAt: Date.UTC(2026, 4, 30, 12),
                }),
                "vscode:root:workspace:uncosted": session("vscode:root:workspace:uncosted", Date.UTC(2026, 5, 5, 12), undefined, {
                    inputTokens: 100,
                    outputTokens: 10,
                }, {}, {
                    state: "closed",
                    source: "none",
                }),
            },
        },
    });

    assert.match(output, /Sessions found\s+\|\s+5 total \(4 CLI, 1 VS Code\)/);
    assert.doesNotMatch(output, /Costed sessions|Uncosted sessions/);
    assert.match(output, /Closed \[AI Cr\]\s+\|\s+1\s+\|\s+\$1\.00\s+\|\s+Exact/);
    assert.match(output, /Open \[AI Cr\]\s+\|\s+1\s+\|\s+\$2\.00\s+\|\s+Est\. High/);
    assert.match(output, /Closed \[Token\]\s+\|\s+2\s+\|\s+\$3\.00\s+\|\s+Estimate/);
    assert.match(output, /Stale \[Token\]\s+\|\s+1\s+\|\s+\$4\.00\s+\|\s+Est\. Low/);
    assert.doesNotMatch(output, /No cost data/);
});

test("overview calendar shows implied thousands for high daily costs instead of capping at 999", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    const output = renderCostOverview({
        now,
        color: false,
        settings: { unit: "gbp" },
        ledger: {
            sessions: {
                lowThousands: session("lowThousands", Date.UTC(2026, 5, 3, 12), nanoAiuForGbp(1200)),
                highThousands: session("highThousands", Date.UTC(2026, 5, 4, 12), nanoAiuForGbp(9900)),
                tenThousand: session("tenThousand", Date.UTC(2026, 5, 5, 12), nanoAiuForGbp(10_000)),
            },
        },
    });

    assert.match(output, /We .*?\|£1\.2\|£-\s+\|/);
    assert.match(output, /Th .*?\|£9\.9\|\s+\|/);
    assert.match(output, /Fr .*?\|£10k\|\s+\|/);
    assert.doesNotMatch(output, /£999/);
});

function session(id, at, totalNanoAiu, tokenTotals = {}, modelMetrics = {}, overrides = {}) {
    return {
        id,
        state: "closed",
        totalNanoAiu,
        source: "shutdown",
        closedAt: at,
        tokenTotals,
        modelMetrics,
        ...overrides,
    };
}

function stripAnsi(value) {
    return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function nanoAiuForGbp(gbp) {
    return Math.round(gbp / BILLING.gbpPerUsd / BILLING.usdPerAiCredit * BILLING.nanoAiuPerAiCredit);
}

function assertApprox(actual, expected) {
    assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} should be close to ${expected}`);
}
