import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import { DISPLAY, STYLE } from "../../src/config.mjs";
import { displays, parseFormat, parseMode, parseUnit } from "../../src/settings.mjs";
import { GENERATED_MARKER } from "../../../../scripts/lib/paths.mjs";

test("parses mode aliases", () => {
    assert.equal(parseMode("after-message"), "message");
    assert.equal(parseMode("messages"), "message");
    assert.equal(parseMode("status line"), "footer");
    assert.equal(parseMode("statusline"), "footer");
    assert.equal(parseMode("both"), "both");
    assert.equal(parseMode("off"), "off");
    assert.equal(parseMode("nope"), null);
});

test("parses unit aliases", () => {
    assert.equal(parseUnit("£"), "gbp");
    assert.equal(parseUnit("pounds"), "gbp");
    assert.equal(parseUnit("$"), "usd");
    assert.equal(parseUnit("dollars"), "usd");
    assert.equal(parseUnit("ai credits"), "credits");
    assert.equal(parseUnit("cr"), "credits");
    assert.equal(parseUnit("tokens"), null);
});

test("gates display surfaces from saved mode", () => {
    assert.equal(displays("both", "message"), true);
    assert.equal(displays("both", "footer"), true);
    assert.equal(displays("message", "message"), true);
    assert.equal(displays("message", "footer"), false);
    assert.equal(displays("footer", "message"), false);
    assert.equal(displays("footer", "footer"), true);
    assert.equal(displays("off", "message"), false);
    assert.equal(displays("off", "footer"), false);
});

test("normalizes formats", () => {
    assert.equal(parseFormat("  {cost}   {msg_cost}  "), "{cost} {msg_cost}");
    assert.equal(parseFormat("   "), null);
});

test("new users get current defaults", async () => {
    assert.deepEqual(await readSettingsInHome(await mkdtemp(join(tmpdir(), "copilot-cost-home-"))), {
        mode: DISPLAY.defaultMode,
        unit: DISPLAY.defaultUnit,
        messageFormat: DISPLAY.defaultMessageFormat,
        footerFormat: DISPLAY.defaultFooterFormat,
    });
});

test("changed users keep mode and unit while inheriting default formats", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    await writeSettings(home, { mode: "footer", unit: "usd" });

    assert.deepEqual(await readSettingsInHome(home), {
        mode: "footer",
        unit: "usd",
        messageFormat: DISPLAY.defaultMessageFormat,
        footerFormat: DISPLAY.defaultFooterFormat,
    });
});

test("saved settings use only current keys", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    await writeSettings(home, {
        mode: "message",
        unit: "credits",
        messageFormat: "{message_group}",
        footerFormat: "{total_group}",
    });

    assert.deepEqual(await readSettingsInHome(home), {
        mode: "message",
        unit: "credits",
        messageFormat: "{message_group}",
        footerFormat: "{total_group}",
    });
});

test("saving settings does not persist default format overrides", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    await runSettingsScript(home, `
        import { DISPLAY } from "./src/config.mjs";
        import { saveSettings } from "./src/settings.mjs";
        await saveSettings({
            mode: "both",
            unit: "gbp",
            messageFormat: DISPLAY.defaultMessageFormat,
            footerFormat: DISPLAY.defaultFooterFormat,
        });
    `);

    const saved = JSON.parse(await readFile(settingsFile(home), "utf8"));
    assert.deepEqual(saved, { mode: "both", unit: "gbp" });
});

test("saving settings preserves custom formats", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    await runSettingsScript(home, `
        import { saveSettings } from "./src/settings.mjs";
        await saveSettings({
            mode: "footer",
            unit: "usd",
            messageFormat: "[{time}] {message_group}",
            footerFormat: "{total_group} / {context_group}",
        });
    `);

    const saved = JSON.parse(await readFile(settingsFile(home), "utf8"));
    assert.deepEqual(saved, {
        mode: "footer",
        unit: "usd",
        messageFormat: "[{time}] {message_group}",
        footerFormat: "{total_group} / {context_group}",
    });
});

test("configure applies direct arguments and reports the saved display", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    const result = JSON.parse(await runSettingsScript(home, `
        import { configure, readSettings } from "./src/settings.mjs";
        const logs = [];
        await configure({ log: async (value) => logs.push(value) }, { args: "off" });
        console.log(JSON.stringify({ logs, settings: await readSettings() }));
    `));

    assert.deepEqual(result, {
        logs: ["Cost display: off, GBP"],
        settings: {
            mode: "off",
            unit: DISPLAY.defaultUnit,
            messageFormat: DISPLAY.defaultMessageFormat,
            footerFormat: DISPLAY.defaultFooterFormat,
        },
    });
});

test("configure logs usage when direct arguments are unknown and elicitation is unavailable", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    const result = JSON.parse(await runSettingsScript(home, `
        import { configure, readSettings } from "./src/settings.mjs";
        const logs = [];
        await configure({ log: async (value) => logs.push(value) }, { args: "format" });
        console.log(JSON.stringify({ logs, settings: await readSettings() }));
    `));

    assert.match(result.logs[0], /^Usage: \/cost message/);
    assert.match(result.logs[0], /When interactive UI is available, \/cost opens overview, Info, and Settings/);
    assert.match(result.logs[0], /Cost overview/);
    assert.match(result.logs[0], /Cost calendar · six months/);
    assert.deepEqual(result.settings, {
        mode: DISPLAY.defaultMode,
        unit: DISPLAY.defaultUnit,
        messageFormat: DISPLAY.defaultMessageFormat,
        footerFormat: DISPLAY.defaultFooterFormat,
    });
});

test("configure applies interactive settings when elicitation is available", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    const result = JSON.parse(await runSettingsScript(home, `
        import { configure, readSettings } from "./src/settings.mjs";
        const logs = [];
        const choices = ["Settings", "Unit", "USD"];
        await configure({
            capabilities: { ui: { elicitation: true } },
            ui: {
                elicitation: async () => ({
                    action: "accept",
                    content: { selection: choices.shift() },
                }),
            },
            log: async (value) => logs.push(value),
        }, { args: "" });
        console.log(JSON.stringify({ logs, settings: await readSettings() }));
    `));

    assert.deepEqual(result, {
        logs: ["Cost display: after each message and footer, USD"],
        settings: {
            mode: DISPLAY.defaultMode,
            unit: "usd",
            messageFormat: DISPLAY.defaultMessageFormat,
            footerFormat: DISPLAY.defaultFooterFormat,
        },
    });
});

test("interactive overview routes verbose metric copy to Info", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    const result = JSON.parse(await runSettingsScript(home, `
        import { configure } from "./src/settings.mjs";
        const requests = [];
        const choices = ["Info", "Back"];
        await configure({
            capabilities: { ui: { elicitation: true } },
            ui: {
                elicitation: async (params) => {
                    requests.push(params);
                    return {
                        action: "accept",
                        content: { selection: choices.shift() },
                    };
                },
            },
            log: async () => {},
        }, { args: "" });
        console.log(JSON.stringify({ requests }));
    `));

    assert.equal(result.requests.length, 3);
    const overviewPrompt = stripAnsi(result.requests[0].message);
    assert.match(overviewPrompt, /Cost overview/);
    assert.match(overviewPrompt, /Cost calendar · six months/);
    assert.match(overviewPrompt, /Choose a section/);
    assert.deepEqual(
        result.requests[0].requestedSchema.properties.selection.oneOf.map((choice) => choice.title),
        ["Info", "Settings"],
    );

    const infoRequest = result.requests[1];
    assert.match(infoRequest.message, new RegExp(escapeRegExp(`${STYLE.last}+£0.03 in 15.4s${STYLE.reset}`)));
    assert.match(infoRequest.message, new RegExp(escapeRegExp(`${STYLE.total}Total £1.24${STYLE.reset}`)));
    assert.match(infoRequest.message, new RegExp(escapeRegExp(`${STYLE.windows}Sess${STYLE.reset}`)));
    assert.match(infoRequest.message, new RegExp(escapeRegExp(`${STYLE.windows}24h/7d/30d${STYLE.reset}`)));
    const prompt = stripAnsi(infoRequest.message);
    assert.match(prompt, /After-message example:/);
    assert.match(prompt, /\+-{20,}\+\n\| \[21:00\] \+£0\.03 in 15\.4s/);
    assert.match(prompt, /\+£0\.03 in 15\.4s/);
    assert.match(prompt, /Footer example:/);
    assert.match(prompt, /\+-{20,}\+\n\| Total £1\.24 · Ctx 48%/);
    assert.match(prompt, /Total £1\.24/);
    assert.match(prompt, /Total £1\.24: best-known current conversation total/);
    assert.match(prompt, /Sess: cumulative official cost for the current Copilot CLI session/);
    assert.match(prompt, /24h\/7d\/30d: rolling cumulative costs from the local session ledger/);
    assert.match(prompt, /statusLine\.command/);
    assert.equal(infoRequest.requestedSchema.properties.selection.enum, undefined);
    assert.ok(Array.isArray(infoRequest.requestedSchema.properties.selection.oneOf));

    assert.match(stripAnsi(result.requests[2].message), /Cost overview/);
});

test("interactive settings submenu uses compact settings copy", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    const result = JSON.parse(await runSettingsScript(home, `
        import { configure } from "./src/settings.mjs";
        const requests = [];
        const choices = ["Settings", "Cancel"];
        await configure({
            capabilities: { ui: { elicitation: true } },
            ui: {
                elicitation: async (params) => {
                    requests.push(params);
                    return {
                        action: "accept",
                        content: { selection: choices.shift() },
                    };
                },
            },
            log: async () => {},
        }, { args: "" });
        console.log(JSON.stringify({ requests }));
    `));

    assert.equal(result.requests.length, 2);
    const settingsPrompt = stripAnsi(result.requests[1].message);
    assert.match(settingsPrompt, /Configure where copilot-cost appears/);
    assert.match(settingsPrompt, /Display location: after-message output/);
    assert.match(settingsPrompt, /Clear Plugin Data: remove all copilot-cost plugin-data files/);
    assert.doesNotMatch(settingsPrompt, /After-message example:/);
});

test("interactive settings ignores typed values outside fixed choices", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    const result = JSON.parse(await runSettingsScript(home, `
        import { configure, readSettings } from "./src/settings.mjs";
        await configure({
            capabilities: { ui: { elicitation: true } },
            ui: {
                elicitation: async () => ({
                    action: "accept",
                    content: { selection: "Other" },
                }),
            },
            log: async () => {},
        }, { args: "" });
        console.log(JSON.stringify({ settings: await readSettings() }));
    `));

    assert.deepEqual(result.settings, {
        mode: DISPLAY.defaultMode,
        unit: DISPLAY.defaultUnit,
        messageFormat: DISPLAY.defaultMessageFormat,
        footerFormat: DISPLAY.defaultFooterFormat,
    });
});

test("interactive uninstall removes managed files after confirmation", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    await writeManagedInstall(home);

    const result = JSON.parse(await runSettingsScript(home, `
        import { readFile, stat } from "node:fs/promises";
        import { join } from "node:path";
        import { configure } from "./src/settings.mjs";
        const logs = [];
        const choices = ["Settings", "Uninstall", "Yes"];
        await configure({
            capabilities: { ui: { elicitation: true } },
            ui: {
                elicitation: async () => ({
                    action: "accept",
                    content: { selection: choices.shift() },
                }),
            },
            log: async (value) => logs.push(value),
        }, { args: "" });

        let shimExists = true;
        try {
            await stat(join(process.env.COPILOT_HOME, "extensions", "copilot-cost"));
        } catch (error) {
            if (error.code === "ENOENT") {
                shimExists = false;
            } else {
                throw error;
            }
        }
        const copilotSettings = JSON.parse(await readFile(join(process.env.COPILOT_HOME, "settings.json"), "utf8"));
        console.log(JSON.stringify({ logs, shimExists, copilotSettings }));
    `));

    assert.equal(result.shimExists, false);
    assert.equal(Object.hasOwn(result.copilotSettings, "statusLine"), false);
    assert.deepEqual(result.copilotSettings.footer, {});
    assert.deepEqual(result.copilotSettings.disabledSkills, ["other-skill"]);
    assert.match(result.logs[0], /Removed native extension shim at /);
    assert.match(result.logs[0], /Restored Copilot statusline settings/);
    assert.match(result.logs[0], /Re-enabled the copilot-cost setup skill/);
    assert.match(result.logs[0], /Restart Copilot CLI or run \/clear/);
    assert.match(result.logs[0], /copilot plugin uninstall copilot-cost/);
});

test("interactive uninstall cancellation leaves managed files untouched", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    await writeManagedInstall(home);

    const result = JSON.parse(await runSettingsScript(home, `
        import { readFile, stat } from "node:fs/promises";
        import { join } from "node:path";
        import { configure } from "./src/settings.mjs";
        const logs = [];
        const choices = ["Settings", "Uninstall", "No"];
        await configure({
            capabilities: { ui: { elicitation: true } },
            ui: {
                elicitation: async () => ({
                    action: "accept",
                    content: { selection: choices.shift() },
                }),
            },
            log: async (value) => logs.push(value),
        }, { args: "" });

        const shim = await stat(join(process.env.COPILOT_HOME, "extensions", "copilot-cost", "extension.mjs"));
        const copilotSettings = JSON.parse(await readFile(join(process.env.COPILOT_HOME, "settings.json"), "utf8"));
        console.log(JSON.stringify({ logs, shimIsFile: shim.isFile(), copilotSettings }));
    `));

    assert.deepEqual(result.logs, ["Uninstall canceled."]);
    assert.equal(result.shimIsFile, true);
    assert.match(result.copilotSettings.statusLine.command, /copilot-cost/);
    assert.deepEqual(result.copilotSettings.disabledSkills, ["other-skill", "ext-cost-setup"]);
});

test("interactive clear plugin data removes the plugin-data directory after confirmation", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));

    const result = JSON.parse(await runSettingsScript(home, `
        import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
        import { join } from "node:path";
        import { configure } from "./src/settings.mjs";

        await mkdir(join(process.env.COPILOT_PLUGIN_DATA, "nested"), { recursive: true });
        await writeFile(join(process.env.COPILOT_PLUGIN_DATA, "settings.json"), JSON.stringify({ mode: "footer" }));
        await writeFile(join(process.env.COPILOT_PLUGIN_DATA, "session-ledger.json"), JSON.stringify({ version: 1, sessions: {} }));
        await writeFile(join(process.env.COPILOT_PLUGIN_DATA, "install-state.json"), JSON.stringify({ hadStatusLine: true }));
        await writeFile(join(process.env.COPILOT_PLUGIN_DATA, "nested", "other.json"), "{}");

        const copilotSettingsPath = join(process.env.COPILOT_HOME, "settings.json");
        await mkdir(join(process.env.COPILOT_HOME), { recursive: true });
        await writeFile(copilotSettingsPath, JSON.stringify({ footer: { showCustom: true } }));

        const logs = [];
        const choices = ["Settings", "Clear Plugin Data", "Yes"];
        await configure({
            capabilities: { ui: { elicitation: true } },
            ui: {
                elicitation: async () => ({
                    action: "accept",
                    content: { selection: choices.shift() },
                }),
            },
            log: async (value) => logs.push(value),
        }, { args: "" });

        let pluginDataExists = true;
        try {
            await stat(process.env.COPILOT_PLUGIN_DATA);
        } catch (error) {
            if (error.code === "ENOENT") {
                pluginDataExists = false;
            } else {
                throw error;
            }
        }
        const copilotSettings = JSON.parse(await readFile(copilotSettingsPath, "utf8"));
        console.log(JSON.stringify({ logs, pluginDataExists, copilotSettings }));
    `));

    assert.equal(result.pluginDataExists, false);
    assert.deepEqual(result.copilotSettings, { footer: { showCustom: true } });
    assert.match(result.logs[0], /Cleared copilot-cost plugin data at /);
    assert.match(result.logs[0], /Restart Copilot CLI or run \/clear/);
});

test("interactive clear plugin data cancellation leaves plugin-data untouched", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));

    const result = JSON.parse(await runSettingsScript(home, `
        import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
        import { join } from "node:path";
        import { configure } from "./src/settings.mjs";

        await mkdir(process.env.COPILOT_PLUGIN_DATA, { recursive: true });
        await writeFile(join(process.env.COPILOT_PLUGIN_DATA, "settings.json"), JSON.stringify({ mode: "footer" }));

        const logs = [];
        const choices = ["Settings", "Clear Plugin Data", "No"];
        await configure({
            capabilities: { ui: { elicitation: true } },
            ui: {
                elicitation: async () => ({
                    action: "accept",
                    content: { selection: choices.shift() },
                }),
            },
            log: async (value) => logs.push(value),
        }, { args: "" });

        const pluginData = await stat(process.env.COPILOT_PLUGIN_DATA);
        const settings = JSON.parse(await readFile(join(process.env.COPILOT_PLUGIN_DATA, "settings.json"), "utf8"));
        console.log(JSON.stringify({ logs, pluginDataIsDirectory: pluginData.isDirectory(), settings }));
    `));

    assert.deepEqual(result.logs, ["Clear plugin data canceled."]);
    assert.equal(result.pluginDataIsDirectory, true);
    assert.deepEqual(result.settings, { mode: "footer" });
});

test("interactive settings can export session data and return to settings", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    const result = JSON.parse(await runSettingsScript(home, `
        import { mkdir, readFile, writeFile } from "node:fs/promises";
        import { join } from "node:path";
        import { configure } from "./src/settings.mjs";

        const sessionDir = join(process.env.COPILOT_HOME, "session-state", "session-a");
        await mkdir(sessionDir, { recursive: true });
        await writeFile(join(sessionDir, "events.jsonl"), JSON.stringify({
            type: "session.shutdown",
            timestamp: "2026-06-10T10:00:00.000Z",
            data: { totalNanoAiu: 500 },
        }) + "\\n");
        await mkdir(process.env.COPILOT_PLUGIN_DATA, { recursive: true });
        await writeFile(join(process.env.COPILOT_PLUGIN_DATA, "session-ledger.json"), JSON.stringify({
            version: 1,
            sessions: {
                "session-a": { id: "session-a", state: "closed", source: "shutdown", totalNanoAiu: 500 },
            },
        }));

        const logs = [];
        const requests = [];
        const choices = ["Settings", "Export Session Data", "Settings", "Cancel"];
        await configure({
            capabilities: { ui: { elicitation: true } },
            workspacePath: process.cwd(),
            ui: {
                elicitation: async (params) => {
                    requests.push(params);
                    return {
                        action: "accept",
                        content: { selection: choices.shift() },
                    };
                },
            },
            log: async (value) => logs.push(value),
        }, { args: "" });

        const rows = (await readFile(join(process.cwd(), "COPILOT_COST_DEBUG.jsonl"), "utf8")).trim().split("\\n").map(JSON.parse);
        console.log(JSON.stringify({ logs, requests, rows }));
    `));

    assert.match(result.logs[0], /Exported 1 Copilot CLI session records/);
    assert.match(result.logs[0], /COPILOT_COST_DEBUG\.jsonl/);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].sessionId, "session-a");
    assert.equal(result.rows[0].extracted.summary.bestTotalNanoAiu, 500);
    assert.deepEqual(
        result.requests[2].requestedSchema.properties.selection.oneOf.map((choice) => choice.title),
        ["Settings", "Done"],
    );
    assert.match(stripAnsi(result.requests[3].message), /Cost display settings/);
});

test("format input help is structured and readable", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-cost-home-"));
    const result = JSON.parse(await runSettingsScript(home, `
        import { configure } from "./src/settings.mjs";
        const choices = ["Settings", "Format", "After message"];
        let inputMessage;
        let inputOptions;
        await configure({
            capabilities: { ui: { elicitation: true } },
            ui: {
                elicitation: async () => ({
                    action: "accept",
                    content: { selection: choices.shift() },
                }),
                input: async (message, options) => {
                    inputMessage = message;
                    inputOptions = options;
                    return null;
                },
            },
            log: async () => {},
        }, { args: "" });
        console.log(JSON.stringify({ inputMessage, inputOptions }));
    `));

    const description = stripAnsi(result.inputOptions.description);
    assert.equal(result.inputMessage, "Set after-message format");
    assert.equal(result.inputOptions.title, "after-message format");
    assert.equal(description.includes("Keywords:"), false);
    assert.match(description, /Format template\nDefault: \[\{time\}\] \{message_group\}/);
    assert.match(description, /Group placeholders render complete labelled segments\n- \{message_group\} -> \+£0\.03 in 15\.4s/);
    assert.match(description, /Value placeholders render bare values for custom labels\n- \{time\}: 21:00/);
    assert.match(description, /- \{cost\}: £1\.24 best-known current conversation total/);
    assert.match(description, /- \{sess_cost\}: £1\.2 current cumulative official Copilot CLI session total/);
    assert.match(description, /- \{cache_read\}\/\{cache_write\}: 96% read\/write cache rates/);
    assert.match(description, /- \{cost_24h\}\/\{cost_7d\}\/\{cost_30d\}: rolling cumulative costs from the local session ledger/);
    assert.match(description, /average recent uncached input\/output work/);
    assert.match(description, /Tips\n- Use group placeholders for ready-made labelled output/);
    assert.equal(description.includes("Tokens render only their value"), false);
});

async function readSettingsInHome(home) {
    return JSON.parse(await runSettingsScript(home, `
        import { readSettings } from "./src/settings.mjs";
        console.log(JSON.stringify(await readSettings()));
    `));
}

function stripAnsi(value) {
    return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function writeSettings(home, value) {
    const dir = pluginDataDir(home);
    await mkdir(dir, { recursive: true });
    await writeFile(settingsFile(home), JSON.stringify(value));
}

async function writeManagedInstall(home) {
    const shimPath = join(home, ".copilot", "extensions", "copilot-cost", "extension.mjs");
    await mkdir(dirname(shimPath), { recursive: true });
    await writeFile(shimPath, `// ${GENERATED_MARKER}\n`);

    const copilotSettingsPath = join(home, ".copilot", "settings.json");
    await mkdir(dirname(copilotSettingsPath), { recursive: true });
    await writeFile(copilotSettingsPath, JSON.stringify({
        statusLine: {
            type: "command",
            command: "node '/plugins/copilot-cost/extensions/copilot-cost/extension.mjs' '--statusline'",
        },
        footer: { showCustom: true },
        disabledSkills: ["other-skill", "ext-cost-setup"],
    }));

    await mkdir(pluginDataDir(home), { recursive: true });
    await writeFile(join(pluginDataDir(home), "install-state.json"), JSON.stringify({
        hadStatusLine: false,
        hadFooterShowCustom: false,
    }));
}

async function runSettingsScript(home, source) {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
        cwd: new URL("../..", import.meta.url),
        env: {
            ...process.env,
            COPILOT_HOME: join(home, ".copilot"),
            COPILOT_PLUGIN_DATA: pluginDataDir(home),
            HOME: home,
        },
        encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

function pluginDataDir(home) {
    return join(home, ".copilot", "plugin-data", "copilot-extensions", "copilot-cost");
}

function settingsFile(home) {
    return join(pluginDataDir(home), "settings.json");
}
