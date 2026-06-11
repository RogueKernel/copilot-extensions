import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { readJsonc, writeJsonWithBackup } from "./jsonc.mjs";
import { extensionEntrypoint, installStatePath, settingsPath, SETUP_SKILL_NAME } from "./paths.mjs";

export async function configureStatusline({
    copilotHome,
    pluginRoot,
    platform = process.platform === "win32" ? "windows" : "posix",
    existingStatusline = "replace",
} = {}) {
    const statusLineCommand = await makeStatusLineCommand({ pluginRoot, platform });
    const settingsFile = settingsPath(copilotHome);
    const { existed, value: settings } = await readJsonc(settingsFile);
    const priorSettings = structuredClone(settings);

    settings.experimental = true;
    settings.footer = isPlainObject(settings.footer) ? settings.footer : {};
    settings.footer.showCustom = true;

    const currentStatusLine = settings.statusLine;
    if (existingStatusline === "skip" && hasOtherStatusline(currentStatusLine)) {
        return { statusLineCommand, settingsChanged: false, skippedExistingStatusline: true };
    }

    if (isPlainObject(currentStatusLine)) {
        settings.statusLine = { ...currentStatusLine, type: "command", command: statusLineCommand };
    } else {
        settings.statusLine = { type: "command", command: statusLineCommand };
    }

    if (JSON.stringify(settings) === JSON.stringify(priorSettings)) {
        return { statusLineCommand, settingsChanged: false };
    }

    await writeInstallState(copilotHome, priorSettings);
    await writeJsonWithBackup(settingsFile, settings, existed);
    return { statusLineCommand, settingsChanged: true };
}

export async function uninstallStatusline({ copilotHome }) {
    const settingsFile = settingsPath(copilotHome);
    const { existed, value: settings } = await readJsonc(settingsFile);
    const state = await readInstallState(copilotHome);
    let settingsChanged = false;
    let statuslineSettingsChanged = false;
    const setupSkillEnabled = removeDisabledSetupSkill(settings);

    if (isPlainObject(settings.statusLine) && isCopilotCostStatusline(settings.statusLine.command)) {
        if (state?.hadStatusLine) {
            settings.statusLine = state.statusLine;
        } else {
            delete settings.statusLine;
        }
        settingsChanged = true;
        statuslineSettingsChanged = true;
    }

    if (state && isPlainObject(settings.footer)) {
        if (state.hadFooterShowCustom) {
            settings.footer.showCustom = state.footerShowCustom;
            settingsChanged = true;
            statuslineSettingsChanged = true;
        } else if (Object.hasOwn(settings.footer, "showCustom")) {
            delete settings.footer.showCustom;
            settingsChanged = true;
            statuslineSettingsChanged = true;
        }
    }

    settingsChanged ||= setupSkillEnabled;

    if (settingsChanged) {
        await writeJsonWithBackup(settingsFile, settings, existed);
    }

    return { settingsChanged, statuslineSettingsChanged, setupSkillEnabled };
}

async function makeStatusLineCommand({ pluginRoot, platform }) {
    assertNoNewlines(pluginRoot);
    const script = extensionEntrypoint(pluginRoot);
    await assertFile(script, "bundled native extension");

    return shellCommand(platform, "node", [script, "--statusline"]);
}

async function assertFile(path, label) {
    try {
        const entry = await stat(path);
        if (entry.isFile()) {
            return;
        }
    } catch (error) {
        if (error?.code !== "ENOENT") {
            throw error;
        }
    }
    throw new Error(`Could not find ${label} at ${path}`);
}

async function writeInstallState(copilotHome, priorSettings) {
    const path = installStatePath(copilotHome);
    try {
        await readFile(path, "utf8");
        return;
    } catch (error) {
        if (error?.code !== "ENOENT") {
            throw error;
        }
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({
        hadStatusLine: Object.hasOwn(priorSettings, "statusLine"),
        statusLine: priorSettings.statusLine ?? null,
        hadFooterShowCustom: Object.hasOwn(priorSettings.footer ?? {}, "showCustom"),
        footerShowCustom: priorSettings.footer?.showCustom ?? null,
        experimental: priorSettings.experimental,
        writtenAt: new Date().toISOString(),
    }, null, 2)}\n`);
}

async function readInstallState(copilotHome) {
    try {
        return JSON.parse(await readFile(installStatePath(copilotHome), "utf8"));
    } catch (error) {
        if (error?.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}

function shellCommand(platform, command, args) {
    const quote = platform === "windows" ? windowsQuote : singleQuote;
    return [shellCommandName(platform, command), ...args.map(quote)].join(" ");
}

function shellCommandName(platform, command) {
    assertNoNewlines(command);
    if (/^[A-Za-z0-9_.-]+$/.test(command)) {
        return command;
    }
    return platform === "windows" ? windowsQuote(command) : singleQuote(command);
}

function isCopilotCostStatusline(command) {
    return typeof command === "string" && /copilot-cost/i.test(command) && /statusline/i.test(command);
}

function hasOtherStatusline(statusLine) {
    return isPlainObject(statusLine)
        && typeof statusLine.command === "string"
        && statusLine.command.length > 0
        && !isCopilotCostStatusline(statusLine.command);
}

function removeDisabledSetupSkill(settings) {
    if (!Array.isArray(settings.disabledSkills)) {
        return false;
    }
    const disabledSkills = settings.disabledSkills.filter((skill) => skill !== SETUP_SKILL_NAME);
    if (disabledSkills.length === settings.disabledSkills.length) {
        return false;
    }
    if (disabledSkills.length > 0) {
        settings.disabledSkills = disabledSkills;
    } else {
        delete settings.disabledSkills;
    }
    return true;
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function singleQuote(value) {
    assertNoNewlines(value);
    return `'${value.replaceAll("'", "'\\''")}'`;
}

function windowsQuote(value) {
    assertNoNewlines(value);
    return `"${value.replaceAll("\"", "\\\"")}"`;
}

function assertNoNewlines(value) {
    if (/[\r\n]/.test(value)) {
        throw new Error("Statusline commands cannot contain newlines");
    }
}

export const testExports = {
    isCopilotCostStatusline,
};
