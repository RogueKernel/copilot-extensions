#!/usr/bin/env node

import { configureStatusline } from "./lib/statusline.mjs";
import { copilotHome, pluginRootFromScript } from "./lib/paths.mjs";

main().catch((error) => {
    console.error(`configure-statusline: ${error.message}`);
    process.exitCode = 1;
});

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const home = copilotHome(args.copilotHome);
    const pluginRoot = args.pluginRoot || pluginRootFromScript(import.meta.url);
    const result = await configureStatusline({
        copilotHome: home,
        pluginRoot,
        platform: args.platform,
        existingStatusline: args.existingStatusline,
    });

    if (result.skippedExistingStatusline) {
        console.log("Skipped statusline configuration because another statusline command is already configured.");
        return;
    }
    const action = result.settingsChanged ? "Configured" : "Verified";
    console.log(`${action} Copilot statusline command: ${result.statusLineCommand}`);
}

function parseArgs(argv) {
    const args = {
        platform: process.platform === "win32" ? "windows" : "posix",
        existingStatusline: "replace",
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
