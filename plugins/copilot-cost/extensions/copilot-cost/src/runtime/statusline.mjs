// Stdin-driven statusline runtime launched directly by Node.
// It must avoid SDK imports so `node extension.mjs --statusline` works in
// isolation from the Copilot extension child-process bootstrap.

import { snapshotStatus } from "../domain/cost.mjs";
import { mergeLiveStatusline, sessionLedgerWindows, updateSessionLedger } from "../domain/session-ledger.mjs";
import { refreshUsageWindows } from "../domain/windows.mjs";
import { readStdin } from "../io.mjs";
import { renderSummary } from "../render/summary.mjs";
import { readSettings, displays } from "../settings.mjs";
import { runFirstRunTasks } from "../first-run.mjs";
import { mergeState, readState, workspacePath } from "../state.mjs";
import { sessionId } from "../storage.mjs";

const FOOTER_PADDING = "\u00a0";

// Reads one status payload, reconciles state, and prints the footer text.
export async function printStatusline() {
    const [input, settings] = await Promise.all([readStdin(), readSettings()]);
    const status = JSON.parse(input || "{}");
    const workspace = workspacePath(status);
    const priorState = await readState(workspace);
    const windows = await reconcileUsageWindows(workspace, status, priorState, Date.now());
    const state = await mergeState(workspace, { ...snapshotStatus(status, priorState), ...windows });

    if (displays(settings.mode, "footer")) {
        process.stdout.write(renderFooter(state, settings));
    }
    await runFirstRunTasks({ workspacePath: workspace, priorState });
}

async function reconcileUsageWindows(workspace, status, priorState, now) {
    if (!workspace) {
        return refreshUsageWindows(now);
    }
    const id = sessionId(status);
    if (id) {
        const ledger = await updateSessionLedger((prior) => mergeLiveStatusline(prior, {
            id,
            totalNanoAiu: status.ai_used?.total_nano_aiu,
            at: now,
        }));
        return sessionLedgerWindows(ledger, now);
    }
    return refreshUsageWindows(now);
}

function renderFooter(state, settings) {
    const summary = renderSummary(state, {
        color: true,
        unit: settings.unit,
        format: settings.footerFormat,
    });
    return `${FOOTER_PADDING}${summary}`;
}
