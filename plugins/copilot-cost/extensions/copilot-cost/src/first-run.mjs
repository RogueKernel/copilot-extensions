// One-time startup actions that are safe to run after the extension has
// successfully persisted its first usable state file.

import { configureStatusline, removeLegacyShim } from "./statusline-setup.mjs";

export async function runStartupTasks(options = {}) {
    const [statusline, legacyShimRemoved] = await Promise.all([
        configureStatusline(options),
        removeLegacyShim(options),
    ]);
    return {
        statuslineConfigured: statusline.statuslineConfigured,
        legacyShimRemoved,
    };
}

// Runs first-run tasks after a successful state write.
export async function runFirstRunTasks({ workspacePath, priorState } = {}, options = {}) {
    if (!workspacePath || priorState !== undefined) {
        return { firstRun: false, statuslineConfigured: false, legacyShimRemoved: false };
    }
    const result = await runStartupTasks(options);
    return {
        firstRun: true,
        ...result,
    };
}
