// Read-only statusline runtime launched directly by Node.
// It must avoid SDK imports so `node extension.mjs --statusline` works in
// isolation from the Copilot extension child-process bootstrap.

import { refreshUsageWindows } from "../domain/windows.mjs";
import { readStdin } from "../io.mjs";
import { renderSummary } from "../render/summary.mjs";
import { readSettings, displays } from "../settings.mjs";
import { readState, workspacePath } from "../state.mjs";

const FOOTER_PADDING = "\u00a0";

// Reads one status payload, loads summary state, and prints the footer text.
export async function printStatusline() {
    const [input, settings] = await Promise.all([readStdin(), readSettings()]);
    const status = JSON.parse(input || "{}");
    const [state, windows] = await Promise.all([
        readState(workspacePath(status)),
        refreshUsageWindows(Date.now()),
    ]);

    if (displays(settings.mode, "footer")) {
        process.stdout.write(renderFooter({ ...state, ...windows }, settings));
    }
}

function renderFooter(state, settings) {
    const summary = renderSummary(state, {
        color: true,
        unit: settings.unit,
        format: settings.footerFormat,
    });
    return `${FOOTER_PADDING}${summary}`;
}
