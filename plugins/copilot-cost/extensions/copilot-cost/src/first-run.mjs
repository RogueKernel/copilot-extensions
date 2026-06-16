// One-time startup actions that are safe to run after the extension has
// successfully persisted its first usable state file.

import { readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { updateJson } from "./io.mjs";
import {
    lifecyclePath as defaultLifecyclePath,
    isLegacySessionCacheFilename,
    isVersionedSessionCacheFilename,
    PLUGIN_VERSION,
    pluginDataDirectory as defaultPluginDataDirectory,
    sessionLedgerFilename,
    sessionLedgerPath as defaultSessionLedgerPath,
    summaryStateFilename,
    summaryStatePath as defaultSummaryStatePath,
} from "./storage.mjs";
import { configureStatusline, removeLegacyShim } from "./statusline-setup.mjs";

export async function runStartupTasks(options = {}) {
    const versionChange = options.skipLedgerReset
        ? { ledgerCleared: false, summaryCleared: false }
        : await resetLedgerOnVersionChange(options);
    const [statusline, legacyShimRemoved] = await Promise.all([
        configureStatusline(options),
        removeLegacyShim(options),
    ]);
    return {
        ledgerCleared: versionChange.ledgerCleared,
        summaryCleared: versionChange.summaryCleared,
        statuslineConfigured: statusline.statuslineConfigured,
        legacyShimRemoved,
    };
}

// Clears rebuildable session caches once per extension version.
export async function resetLedgerOnVersionChange(options = {}) {
    const extensionVersion = options.extensionVersion ?? await defaultExtensionVersion();
    const lifecycleFile = options.lifecyclePath ?? scopedPath(options.pluginDataDirectory, "lifecycle.json", defaultLifecyclePath);
    const ledgerFile = options.sessionLedgerPath ?? scopedPath(options.pluginDataDirectory, sessionLedgerFilename(extensionVersion), () => defaultSessionLedgerPath(extensionVersion));
    const summaryFile = options.summaryStatePath ?? scopedPath(options.pluginDataDirectory, summaryStateFilename(extensionVersion), () => defaultSummaryStatePath(extensionVersion));
    const dataDirectory = options.pluginDataDirectory ?? defaultPluginDataDirectory();
    let result = { ledgerCleared: false, summaryCleared: false, fromVersion: undefined, toVersion: extensionVersion };

    await updateJson(lifecycleFile, async (state = {}) => {
        const priorVersion = state?.extensionVersion;
        if (priorVersion === extensionVersion) {
            return { ...state, extensionVersion };
        }

        const filesToClear = await sessionCacheFilesToClear(dataDirectory, {
            ledgerFile,
            summaryFile,
            currentVersion: extensionVersion,
        });
        const shouldClear = priorVersion !== undefined || filesToClear.length > 0;
        const cleared = shouldClear ? await clearSessionCacheFiles(filesToClear) : { ledgerCleared: false, summaryCleared: false };
        result = {
            ledgerCleared: cleared.ledgerCleared,
            summaryCleared: cleared.summaryCleared,
            fromVersion: priorVersion,
            toVersion: extensionVersion,
        };
        return { ...state, extensionVersion };
    });

    return result;
}

// Runs first-run tasks after a successful state write.
export async function runFirstRunTasks({ workspacePath, priorState } = {}, options = {}) {
    if (!workspacePath || priorState !== undefined) {
        return { firstRun: false, ledgerCleared: false, summaryCleared: false, statuslineConfigured: false, legacyShimRemoved: false };
    }
    const result = await runStartupTasks({ ...options, skipLedgerReset: true });
    return {
        firstRun: true,
        ...result,
    };
}

async function defaultExtensionVersion() {
    return PLUGIN_VERSION;
}

function scopedPath(directory, filename, fallback) {
    return directory ? join(directory, filename) : fallback();
}

async function fileExists(path) {
    try {
        return (await stat(path)).isFile();
    } catch (error) {
        if (error?.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}

async function sessionCacheFilesToClear(directory, { ledgerFile, summaryFile, currentVersion } = {}) {
    const currentLedgerName = sessionLedgerFilename(currentVersion);
    const currentSummaryName = summaryStateFilename(currentVersion);
    const paths = new Set();
    if (await fileExists(ledgerFile)) {
        paths.add(ledgerFile);
    }
    if (await fileExists(summaryFile)) {
        paths.add(summaryFile);
    }

    let entries;
    try {
        entries = await readdir(directory);
    } catch (error) {
        if (error?.code === "ENOENT") {
            return [...paths];
        }
        throw error;
    }

    for (const name of entries) {
        if (name === currentLedgerName || name === currentSummaryName) {
            continue;
        }
        if (isLegacySessionCacheFilename(name) || isVersionedSessionCacheFilename(name)) {
            paths.add(join(directory, name));
        }
    }
    return [...paths];
}

async function clearSessionCacheFiles(paths) {
    let ledgerCleared = false;
    let summaryCleared = false;
    for (const path of paths) {
        const name = basename(path);
        await rm(path, { force: true });
        ledgerCleared ||= name.startsWith("session-ledger");
        summaryCleared ||= name.startsWith("summary-state");
    }
    return { ledgerCleared, summaryCleared };
}
