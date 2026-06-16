// Returns rolling cost windows from the lightweight summary state.

import { pruneSummarySessions, readUsageWindows, saveUsageWindows } from "../summary-state.mjs";
import { sessionLedgerPath } from "../storage.mjs";
import { sessionLedgerWindows, updateSessionLedger } from "./session-ledger.mjs";

// Reads cached 24h, 7d, and 30d totals without touching the full ledger.
export async function refreshUsageWindows(now = Date.now()) {
    return readUsageWindows(now);
}

// Recomputes cached rolling windows after a full ledger sync.
export async function refreshUsageWindowsFromLedger(ledger, now = Date.now(), summaryPath) {
    const windows = sessionLedgerWindows(ledger, now);
    await saveUsageWindows(windows, { updatedAt: now }, summaryPath);
    await pruneSummarySessions(closedLedgerSessionIds(ledger), summaryPath);
    return windows;
}

// Writes the derived ledger cache during full sync and refreshes the hot-path summary cache.
export async function syncSessionLedgerCacheAndSummary(updater, path = sessionLedgerPath(), now = Date.now(), summaryPath) {
    const ledger = await updateSessionLedger(updater, path);
    await refreshUsageWindowsFromLedger(ledger, now, summaryPath);
    return ledger;
}

function closedLedgerSessionIds(ledger = {}) {
    return Object.values(ledger.sessions ?? {})
        .filter((session) => session?.id && session.state !== "open")
        .map((session) => session.id);
}
