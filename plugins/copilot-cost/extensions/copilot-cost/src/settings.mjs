// Manages saved cost display preferences and the /cost command flow.
// This module is the user-settings seam: runtimes read normalized preferences,
// while command handlers update them through direct args or interactive UI.

import { DISPLAY, STYLE } from "./config.mjs";
import { readSessionLedger } from "./domain/session-ledger.mjs";
import { readJson, writeJson } from "./io.mjs";
import { paint, parseFormat as parseFormatValue } from "./render/format.mjs";
import { renderCostOverview } from "./render/overview.mjs";
import { settingsPath } from "./storage.mjs";
import { readState } from "./state.mjs";
import { copilotHome as managedCopilotHome } from "../../../scripts/lib/paths.mjs";
import { uninstallExtensionShim } from "../../../scripts/lib/shim.mjs";
import { uninstallStatusline } from "../../../scripts/lib/statusline.mjs";

// Reads current preferences.
export async function readSettings() {
    const settings = await readJson(settingsPath());
    return {
        mode: parseMode(settings?.mode) ?? DISPLAY.defaultMode,
        unit: parseUnit(settings?.unit) ?? DISPLAY.defaultUnit,
        messageFormat: savedFormat(settings?.messageFormat, DISPLAY.defaultMessageFormat),
        footerFormat: savedFormat(settings?.footerFormat, DISPLAY.defaultFooterFormat),
    };
}

// Persists preferences through the shared JSON writer.
export async function saveSettings(settings) {
    await writeJson(settingsPath(), savedSettings(settings));
}

// Applies direct /cost arguments first, then falls back to the interactive picker.
export async function configure(session, { args }) {
    const settings = await readSettings();
    const nextSettings = directSettings(settings, args) ?? await prompt(session, settings);
    if (nextSettings) {
        await saveAndReport(session, nextSettings);
    }
}

function directSettings(settings, args) {
    const patch = parseSettingPatch(args);
    return hasValues(patch) ? { ...settings, ...patch } : null;
}

function parseSettingPatch(value) {
    const mode = parseMode(value);
    const unit = parseUnit(value);
    return { ...(mode ? { mode } : {}), ...(unit ? { unit } : {}) };
}

function hasValues(value) {
    return Object.keys(value).length > 0;
}

// Parses saved and direct-argument display location values.
export function parseMode(value) {
    const mode = String(value ?? "").trim().toLowerCase().replace(/[_-]/g, " ");
    if (["message", "messages", "after each message", "after message"].includes(mode)) {
        return "message";
    }
    if (["footer", "statusline", "status line", "in footer"].includes(mode)) {
        return "footer";
    }
    return (mode === "both" || mode === "off") ? mode : null;
}

// Parses saved and direct-argument display currency values.
export function parseUnit(value) {
    const unit = String(value ?? "").trim().toLowerCase().replace(/[_-]/g, " ");
    if (["gbp", "pound", "pounds", "£"].includes(unit)) {
        return "gbp";
    }
    if (["usd", "dollar", "dollars", "$"].includes(unit)) {
        return "usd";
    }
    if (["credit", "credits", "ai credit", "ai credits", "cr"].includes(unit)) {
        return "credits";
    }
    return null;
}

// Normalizes a user-supplied summary template.
export function parseFormat(value) {
    return parseFormatValue(value);
}

function savedFormat(value, fallback) {
    return parseFormat(value) ?? fallback;
}

function savedSettings(settings = {}) {
    return dropUndefined({
        mode: settings.mode,
        unit: settings.unit,
        messageFormat: formatForSave(settings.messageFormat, DISPLAY.defaultMessageFormat),
        footerFormat: formatForSave(settings.footerFormat, DISPLAY.defaultFooterFormat),
    });
}

// Persists a format only when it differs from the default, keeping files minimal.
function formatForSave(value, fallback) {
    const parsedFormat = parseFormat(value);
    return (parsedFormat && parsedFormat !== fallback) ? parsedFormat : undefined;
}

function dropUndefined(value) {
    return Object.fromEntries(Object.entries(value ?? {}).filter(([, item]) => item !== undefined));
}

// Answers whether a display mode should render on a given surface.
export function displays(mode, surface) {
    return mode === surface || mode === "both";
}

async function saveAndReport(session, settings) {
    await saveSettings(settings);
    await session.log(`Cost display: ${DISPLAY.labels[settings.mode]}, ${DISPLAY.labels[settings.unit]}`);
}

async function prompt(session, settings) {
    if (!session.capabilities?.ui?.elicitation) {
        await session.log([
            "Usage: /cost message | footer | both | off | gbp | usd | credits. When interactive UI is available, /cost opens overview, Info, and Settings.",
            await overviewText(session, settings),
        ].join("\n\n"));
        return null;
    }

    const selection = await selectChoice(session, await overviewPrompt(session, settings), DISPLAY.menuChoices);
    if (selection === "Info") {
        return promptInfo(session, settings);
    }
    if (selection === "Settings") {
        return promptSettings(session, settings);
    }
    return null;
}

async function promptInfo(session, settings) {
    const selection = await selectChoice(session, infoPrompt(), DISPLAY.infoChoices);
    if (selection === "Settings") {
        return promptSettings(session, settings);
    }
    if (selection === "Back") {
        return prompt(session, settings);
    }
    return null;
}

async function promptSettings(session, settings) {
    const setting = await selectChoice(session, settingsPrompt("Cost display settings"), DISPLAY.settingChoices);
    if (setting === "Display location") {
        return promptMode(session, settings);
    }
    if (setting === "Unit") {
        return promptUnit(session, settings);
    }
    if (setting === "Format") {
        return promptFormatSurface(session, settings);
    }
    if (setting === "Uninstall") {
        await promptUninstall(session);
        return null;
    }
    return null;
}

async function promptMode(session, settings) {
    const mode = parseMode(await selectChoice(session, settingsPrompt("Show Copilot cost where?"), DISPLAY.locationChoices));
    return { ...settings, ...(mode ? { mode } : {}) };
}

async function promptUnit(session, settings) {
    const unit = parseUnit(await selectChoice(session, settingsPrompt("Show cost as?"), DISPLAY.unitChoices));
    return { ...settings, ...(unit ? { unit } : {}) };
}

async function promptFormatSurface(session, settings) {
    const surface = await selectChoice(session, settingsPrompt("Format which output?"), DISPLAY.formatChoices);
    if (surface === "After message") {
        return promptFormat(session, settings, "messageFormat", "after-message");
    }
    if (surface === "Footer") {
        return promptFormat(session, settings, "footerFormat", "footer");
    }
    return null;
}

async function promptFormat(session, settings, key, label) {
    const defaultFormat = defaultFormatFor(key);
    const format = await session.ui.input(`Set ${label} format`, {
        title: `${label} format`,
        description: formatHelpText(defaultFormat),
        default: settings[key] ?? defaultFormat,
        maxLength: 300,
    });
    if (format === null) {
        return null;
    }
    return { ...settings, [key]: parseFormat(format) ?? defaultFormat };
}

async function promptUninstall(session) {
    const confirmed = await selectChoice(session, [
        "Uninstall copilot-cost?",
        "",
        "This removes the managed native extension shim and restores prior Copilot statusline/footer settings.",
        "The plugin package remains installed until you run: copilot plugin uninstall copilot-cost",
    ].join("\n"), DISPLAY.uninstallChoices);

    if (confirmed !== "Yes") {
        await session.log("Uninstall canceled.");
        return;
    }

    try {
        await session.log(formatUninstallResult(await uninstallManagedExtension()));
    } catch (error) {
        await session.log(`Uninstall failed: ${error.message}`);
    }
}

async function uninstallManagedExtension() {
    const home = managedCopilotHome();
    const shim = await uninstallExtensionShim({ copilotHome: home });
    const statusline = await uninstallStatusline({ copilotHome: home });
    return { shim, statusline };
}

function formatUninstallResult({ shim, statusline }) {
    const lines = [
        shim.removed ? `Removed native extension shim at ${shim.targetDirectory}` : shim.reason,
        statusline.statuslineSettingsChanged ? "Restored Copilot statusline settings." : "No managed statusline setting was active.",
    ];
    if (statusline.setupSkillEnabled) {
        lines.push("Re-enabled the copilot-cost setup skill for future installs.");
    }
    lines.push(
        "Restart Copilot CLI or run /clear for this change to take effect.",
        "To remove the plugin package itself, run: copilot plugin uninstall copilot-cost",
    );
    return lines.join("\n");
}

function defaultFormatFor(key) {
    return key === "messageFormat" ? DISPLAY.defaultMessageFormat : DISPLAY.defaultFooterFormat;
}

async function overviewPrompt(session, settings) {
    return `${await overviewText(session, settings)}\n\nChoose a section.`;
}

async function overviewText(session, settings) {
    return renderCostOverview({
        ledger: await readSessionLedger(),
        state: await readState(session.workspacePath),
        settings,
    });
}

function infoPrompt() {
    return `${settingsHelpText()}\n\nChoose where to go next.`;
}

function settingsPrompt(title) {
    return `${title}\n\n${settingsSummaryText()}`;
}

async function selectChoice(session, message, choices) {
    const result = await session.ui.elicitation({
        message,
        requestedSchema: {
            type: "object",
            properties: {
                selection: {
                    type: "string",
                    oneOf: choices.map((choice) => ({ const: choice, title: choice })),
                },
            },
            required: ["selection"],
        },
    });
    const selection = result.action === "accept" ? result.content?.selection : null;
    return choices.includes(selection) ? selection : null;
}

function settingsHelpText() {
    const time = paint("[21:00]", STYLE.text, true);
    const message = paint("+£0.03 in 15.4s", STYLE.last, true);
    const next = paint("Next >= [£0.03 - £0.14]", STYLE.next, true);
    const cache = paint("Cache 96% read", STYLE.cache, true);
    const total = paint("Total £1.24", STYLE.total, true);
    const context = paint("Ctx 48% (96k/200k)", STYLE.context, true);
    const windows = paint("Sess £1.2 · 24h £0 · 7d £2 · 30d £8", STYLE.windows, true);
    return [
        "After-message example:",
        boxedLine(`${time} ${message} · ${next} · ${cache}`),
        `- ${time}: when the assistant response finished.`,
        `- ${message}: observed cost and elapsed time for the last assistant message.`,
        `- ${next}: estimated minimum cost range for the next message; first assumes most context is cached, second assumes stale-cache context charged as uncached input or cache write. Both add average recent uncached input/output work from the last 5 messages.`,
        `- ${cache}: percentage of input served from cache; write appears only when cache writes are charged.`,
        "",
        "Footer example:",
        boxedLine(`${total} · ${context} · ${windows}`),
        `- ${total}: best-known current conversation total; local usage is pending until official usage catches up.`,
        `- ${context}: current context usage and context limit.`,
        `- ${paint("Sess", STYLE.windows, true)}: cumulative official cost for the current Copilot CLI session.`,
        `- ${paint("24h/7d/30d", STYLE.windows, true)}: rolling cumulative costs from the local session ledger.`,
        "- Footer output uses Copilot CLI's built-in Custom Footer; ext-cost-setup configures statusLine.command and footer.showCustom.",
    ].join("\n");
}

function settingsSummaryText() {
    return [
        "Configure where copilot-cost appears, which unit it uses, how summaries are formatted, or remove the managed install.",
        "",
        "Settings",
        "- Display location: after-message output, footer output, both, or off.",
        "- Unit: GBP, USD, or AI Credits.",
        "- Format: customize after-message and footer summary templates.",
        "- Uninstall: remove the managed native extension shim and restore prior Copilot statusline/footer settings.",
    ].join("\n");
}

function formatHelpText(defaultFormat) {
    return [
        settingsHelpText(),
        "",
        "Format template",
        `Default: ${paint(defaultFormat, STYLE.text, true)}`,
        "",
        "Group placeholders render complete labelled segments",
        `- ${paint("{message_group}", STYLE.last, true)} -> +£0.03 in 15.4s`,
        `- ${paint("{next_group}", STYLE.next, true)} -> Next >= [£0.03 - £0.14]`,
        `- ${paint("{cache_group}", STYLE.cache, true)} -> Cache 96% read`,
        `- ${paint("{total_group}", STYLE.total, true)} -> Total £1.24`,
        `- ${paint("{context_group}", STYLE.context, true)} -> Ctx 48% (96k/200k)`,
        `- ${paint("{windows_group}", STYLE.windows, true)} -> Sess £1.2 · 24h £0 · 7d £2 · 30d £8`,
        "",
        "Value placeholders render bare values for custom labels",
        "- {time}: 21:00",
        "- {cost}: £1.24 best-known current conversation total",
        "- {sess_cost}: £1.2 current cumulative official Copilot CLI session total",
        "- {msg_cost}: +£0.03 last assistant message cost",
        "- {msg_time}: 15.4s last assistant message time",
        "- {cached}/{uncached}: £0.03/£0.14 next-message minimum-cost estimate with warm-cache vs stale-cache context, plus average recent uncached input/output work",
        "- {cost_24h}/{cost_7d}/{cost_30d}: rolling cumulative costs from the local session ledger",
        "- {ctx_used}/{ctx_total}: 96k/200k context tokens",
        "- {cache_read}/{cache_write}: 96% read/write cache rates; {cache_write} is empty when unavailable",
        "",
        "Tips",
        "- Use group placeholders for ready-made labelled output.",
        "- Use value placeholders when you want your own labels, brackets, or separators.",
        "- Delete placeholders to hide stats.",
        "- Unknown placeholders are left visible so typos are easy to spot.",
        "- Leave empty to restore the default.",
    ].join("\n");
}

function boxedLine(line) {
    const width = visibleLength(line);
    const border = `+${"-".repeat(width + 2)}+`;
    return [
        border,
        `| ${line} |`,
        border,
    ].join("\n");
}

function visibleLength(value) {
    return value.replace(/\x1b\[[0-9;]*m/g, "").length;
}
