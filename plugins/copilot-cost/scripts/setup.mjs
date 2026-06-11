#!/usr/bin/env node

import { copilotHome, pluginRootFromScript } from "./lib/paths.mjs";
import { installExtensionShim } from "./lib/shim.mjs";
import { configureStatusline } from "./lib/statusline.mjs";

main().catch((error) => {
    console.error(`setup: ${error.message}`);
    process.exitCode = 1;
});

async function main() {
    assertSupportedNode();
    const args = parseArgs(process.argv.slice(2));
    const home = copilotHome(args.copilotHome);
    const pluginRoot = args.pluginRoot || pluginRootFromScript(import.meta.url);

    const shim = await installExtensionShim({ copilotHome: home, pluginRoot });
    console.log(`${shim.changed ? "Installed" : "Verified"} lean native extension shim at ${shim.targetExtension}`);
    console.log("It just loads the extension code bundled with the plugin:");
    console.log(`\`\`\`js\n${shim.content.trimEnd()}\n\`\`\``);

    if (!args.skipStatusline) {
        const statusline = await configureStatusline({
            copilotHome: home,
            pluginRoot,
            platform: args.platform,
            existingStatusline: args.existingStatusline,
        });
        if (statusline.skippedExistingStatusline) {
            console.log("Skipped statusline configuration because another statusline command is already configured.");
        } else {
            console.log(`${statusline.settingsChanged ? "Configured" : "Verified"} statusline command: ${statusline.statusLineCommand}`);
        }
    }

    console.log("Done. Run /clear or start a new Copilot CLI session so Copilot discovers the native extension.");
}

function assertSupportedNode() {
    const major = Number.parseInt(process.versions.node.split(".")[0], 10);
    if (!Number.isFinite(major) || major < 18) {
        throw new Error(`copilot-cost setup requires Node.js 18 or newer; found ${process.version}`);
    }
}

function parseArgs(argv) {
    const args = {
        platform: process.platform === "win32" ? "windows" : "posix",
        existingStatusline: "replace",
        skipStatusline: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--copilot-home") {
            args.copilotHome = readValue(argv, ++index, arg);
        } else if (arg === "--plugin-root") {
            args.pluginRoot = readValue(argv, ++index, arg);
        } else if (arg === "--platform") {
            args.platform = readValue(argv, ++index, arg);
            if (!["posix", "windows"].includes(args.platform)) {
                throw new Error("--platform must be posix or windows");
            }
        } else if (arg === "--existing-statusline") {
            args.existingStatusline = readValue(argv, ++index, arg);
            if (!["replace", "skip"].includes(args.existingStatusline)) {
                throw new Error("--existing-statusline must be replace or skip");
            }
        } else if (arg === "--skip-statusline") {
            args.skipStatusline = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return args;
}

function readValue(argv, index, flag) {
    const value = argv[index];
    if (!value) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}
