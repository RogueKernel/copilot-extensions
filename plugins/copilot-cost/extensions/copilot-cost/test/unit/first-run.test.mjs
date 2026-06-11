import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { disableSetupSkill, runFirstRunTasks } from "../../src/first-run.mjs";

test("runFirstRunTasks disables the setup skill after first persisted workspace state", async () => {
    const settingsPath = await tempSettingsPath();

    const result = await runFirstRunTasks(
        { workspacePath: "/workspace", priorState: undefined },
        { settingsPath },
    );

    assert.deepEqual(result, { firstRun: true, setupSkillDisabled: true });
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
        disabledSkills: ["ext-cost-setup"],
    });
});

test("runFirstRunTasks skips sessions that already have state or no persisted workspace", async () => {
    const settingsPath = await tempSettingsPath();

    assert.deepEqual(await runFirstRunTasks(
        { workspacePath: "/workspace", priorState: { totalUsd: 1 } },
        { settingsPath },
    ), { firstRun: false, setupSkillDisabled: false });
    assert.deepEqual(await runFirstRunTasks(
        { workspacePath: undefined, priorState: undefined },
        { settingsPath },
    ), { firstRun: false, setupSkillDisabled: false });

    await assert.rejects(() => readFile(settingsPath, "utf8"), { code: "ENOENT" });
});

test("disableSetupSkill preserves existing disabled skills and is idempotent", async () => {
    const settingsPath = await tempSettingsPath();
    await writeFile(settingsPath, JSON.stringify({
        renderMarkdown: true,
        disabledSkills: ["other-skill"],
    }));

    assert.equal(await disableSetupSkill({ settingsPath }), true);
    assert.equal(await disableSetupSkill({ settingsPath }), false);

    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
        renderMarkdown: true,
        disabledSkills: ["other-skill", "ext-cost-setup"],
    });
});

test("disableSetupSkill replaces invalid disabledSkills with the managed setup skill", async () => {
    const settingsPath = await tempSettingsPath();
    await writeFile(settingsPath, JSON.stringify({ disabledSkills: "not-an-array" }));

    assert.equal(await disableSetupSkill({ settingsPath }), true);

    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
        disabledSkills: ["ext-cost-setup"],
    });
});

async function tempSettingsPath() {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-settings-"));
    return join(home, "settings.json");
}
