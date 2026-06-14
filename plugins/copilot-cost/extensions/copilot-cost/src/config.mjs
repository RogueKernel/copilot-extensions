// Shared configuration for cost accounting and display.
// Runtime modules import these constants rather than duplicating billing
// exchange rates, statusline defaults, or user-visible format placeholders.

export const BILLING = {
    usdPerAiCredit: 0.01,
    // Copilot telemetry still calls this AIU in places; 1 AIU is 1 AI Credit.
    nanoAiuPerAiCredit: 1_000_000_000,
    gbpPerUsd: 0.74,
    cacheHitRatio: 0.95,
    newWorkSampleLimit: 5,
};

export const HISTORY = {
    retentionDays: 180,
    moneyPricingStartedAt: Date.UTC(2026, 5, 1),
};

const DEFAULT_MESSAGE_FORMAT = "[{time}] {message_group} · {next_group} · {cache_group}";
const DEFAULT_FOOTER_FORMAT = "{total_group} · {context_group} · {windows_group}";

export const DISPLAY = {
    defaultMode: "both",
    defaultUnit: "gbp",
    defaultFormat: DEFAULT_FOOTER_FORMAT,
    defaultMessageFormat: DEFAULT_MESSAGE_FORMAT,
    defaultFooterFormat: DEFAULT_FOOTER_FORMAT,
    // User-visible placeholders accepted by custom summary templates.
    // render/summary.mjs owns the matching token implementation.
    formatTokens: [
        "{message_group}", "{cache_group}",
        "{total_group}", "{windows_group}", "{next_group}", "{context_group}",
        "{time}", "{cost}", "{msg_cost}", "{msg_time}",
        "{cached}", "{uncached}", "{sess_cost}", "{cost_24h}", "{cost_7d}", "{cost_30d}",
        "{ctx_used}", "{ctx_total}",
        "{cache_read}", "{cache_write}",
    ],
    locationChoices: ["After each message", "In footer", "Both", "Off"],
    unitChoices: ["GBP", "USD", "AI Credits"],
    formatChoices: ["After message", "Footer", "Cancel"],
    menuChoices: ["Info", "Settings"],
    infoChoices: ["Settings", "Back"],
    uninstallChoices: ["Yes", "No"],
    clearDataChoices: ["Yes", "No"],
    exportChoices: ["Settings", "Done"],
    settingChoices: ["Display location", "Unit", "Format", "Export Session Data", "Clear Plugin Data", "Uninstall", "Cancel"],
    labels: {
        message: "after each message",
        footer: "footer",
        both: "after each message and footer",
        off: "off",
        gbp: "GBP",
        usd: "USD",
        credits: "AI Credits",
    },
};

// Named ANSI color palette. Use semantic STYLE keys below in feature code.
export const ANSI = {
    reset: "\x1b[0m",
    brightBlack: "\x1b[90m",
    brightWhite: "\x1b[97m",
    gray: "\x1b[38;5;250m",
    skyBlue: "\x1b[38;5;75m",
    lavender: "\x1b[38;5;140m",
    sand: "\x1b[38;5;180m",
    green: "\x1b[38;5;28m",
    yellow: "\x1b[38;5;184m",
    orange: "\x1b[38;5;208m",
    redOrange: "\x1b[38;5;202m",
    red: "\x1b[38;5;196m",
    powderBlue: "\x1b[38;5;110m",
    slate: "\x1b[38;5;66m",
    amber: "\x1b[38;5;136m",
    bgDarkGray: "\x1b[48;5;238m",
    bgGreen: "\x1b[48;5;22m",
    bgOlive: "\x1b[48;5;58m",
    bgBrown: "\x1b[48;5;94m",
    bgOrange: "\x1b[48;5;130m",
    bgRed: "\x1b[48;5;88m",
};

// Semantic ANSI styles used by render modules.
export const STYLE = {
    text: ANSI.brightBlack,
    total: ANSI.skyBlue,
    windows: ANSI.lavender,
    context: ANSI.sand,
    heading: ANSI.brightWhite,
    label: ANSI.brightWhite,
    last: ANSI.green,
    next: ANSI.powderBlue,
    cache: ANSI.slate,
    cacheWarning: ANSI.amber,
    costLow: ANSI.green,
    costMedium: ANSI.yellow,
    costHigh: ANSI.orange,
    costVeryHigh: ANSI.redOrange,
    costCritical: ANSI.red,
    calendarEmptyBg: ANSI.bgDarkGray,
    costZeroBg: `${ANSI.gray}${ANSI.bgDarkGray}`,
    costLowBg: `${ANSI.brightWhite}${ANSI.bgGreen}`,
    costMediumBg: `${ANSI.brightWhite}${ANSI.bgOlive}`,
    costHighBg: `${ANSI.brightWhite}${ANSI.bgBrown}`,
    costVeryHighBg: `${ANSI.brightWhite}${ANSI.bgOrange}`,
    costCriticalBg: `${ANSI.brightWhite}${ANSI.bgRed}`,
    nextCached: ANSI.powderBlue,
    nextUncached: ANSI.powderBlue,
    reset: ANSI.reset,
};
