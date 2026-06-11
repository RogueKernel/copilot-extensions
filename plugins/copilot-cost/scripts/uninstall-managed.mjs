#!/usr/bin/env node

import { copilotHome } from "./lib/paths.mjs";
import { uninstallExtensionShim } from "./lib/shim.mjs";
import { uninstallStatusline } from "./lib/statusline.mjs";

main().catch((error) => {
    console.error(`uninstall-managed: ${error.message}`);
    process.exitCode = 1;
});

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const home = copilotHome(args.copilotHome);
    const shim = await uninstallExtensionShim({ copilotHome: home });
    const statusline = await uninstallStatusline({ copilotHome: home });

    console.log(shim.removed ? `Removed native extension shim at ${shim.targetDirectory}` : shim.reason);
    console.log(statusline.statuslineSettingsChanged ? "Restored Copilot statusline settings." : "No managed statusline setting was active.");
    if (statusline.setupSkillEnabled) {
        console.log("Re-enabled the copilot-cost setup skill for future installs.");
    }
    console.log("To remove the plugin package itself, run: copilot plugin uninstall copilot-cost");
}

function parseArgs(argv) {
    const args = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--copilot-home") {
            args.copilotHome = readValue(argv, ++index, arg);
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
