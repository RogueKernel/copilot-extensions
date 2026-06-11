// Returns rolling cost windows from the session ledger.

import { readSessionLedger, sessionLedgerWindows } from "./session-ledger.mjs";

// Loads the compact per-session ledger and returns 24h, 7d, and 30d totals.
export async function refreshUsageWindows(now = Date.now()) {
    return sessionLedgerWindows(await readSessionLedger(), now);
}
