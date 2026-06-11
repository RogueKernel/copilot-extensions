// One-time startup actions that are safe to run after the extension has
// successfully persisted its first usable state file.

import { SETUP } from "./config.mjs";
import { readJson, writeJson } from "./io.mjs";
import { copilotSettingsPath } from "./storage.mjs";

// Runs first-run tasks after a successful state write.
export async function runFirstRunTasks({ workspacePath, priorState } = {}, options = {}) {
    if (!workspacePath || priorState !== undefined) {
        return { firstRun: false, setupSkillDisabled: false };
    }
    return {
        firstRun: true,
        setupSkillDisabled: await disableSetupSkill(options),
    };
}

// Adds the setup skill to Copilot CLI's disabledSkills list.
export async function disableSetupSkill({
    settingsPath = copilotSettingsPath(),
    skillName = SETUP.skillName,
} = {}) {
    const settings = await readJson(settingsPath) ?? {};
    const disabledSkills = Array.isArray(settings.disabledSkills) ? settings.disabledSkills : [];
    if (disabledSkills.includes(skillName)) {
        return false;
    }

    await writeJson(settingsPath, {
        ...settings,
        disabledSkills: [...disabledSkills, skillName],
    });
    return true;
}
