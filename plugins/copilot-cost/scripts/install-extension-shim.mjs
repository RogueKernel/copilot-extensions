#!/usr/bin/env node

import { copilotHome, pluginRootFromScript } from "./lib/paths.mjs";
import { installExtensionShim } from "./lib/shim.mjs";

main().catch((error) => {
    console.error(`install-extension-shim: ${error.message}`);
    process.exitCode = 1;
});

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const home = copilotHome(args.copilotHome);
    const pluginRoot = args.pluginRoot || pluginRootFromScript(import.meta.url);
    const result = await installExtensionShim({ copilotHome: home, pluginRoot });
    const action = result.changed ? "Installed" : "Verified";
    console.log(`${action} native extension shim at ${result.targetExtension}`);
    console.log(`Shim imports ${result.sourceExtension}`);
}

function parseArgs(argv) {
    const args = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--copilot-home") {
            args.copilotHome = readValue(argv, ++index, arg);
        } else if (arg === "--plugin-root") {
            args.pluginRoot = readValue(argv, ++index, arg);
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
