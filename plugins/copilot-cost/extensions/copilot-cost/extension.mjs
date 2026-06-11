#!/usr/bin/env node

// Host-discovered Copilot CLI extension entrypoint.
// Keep this file thin: it is evaluated both by the SDK bootstrap and by plain
// Node when the statusline command runs with `--statusline`.

import { runExtension } from "./src/runtime/extension.mjs";
import { printStatusline } from "./src/runtime/statusline.mjs";

if (process.argv.includes("--statusline")) {
    await printStatusline();
} else {
    await runExtension();
}
