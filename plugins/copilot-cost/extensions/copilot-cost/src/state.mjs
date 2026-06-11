// Shared adapter for runtime display/accounting state.
// Runtime state is kept inside session-ledger.json so all product-owned cost
// data lives in one atomically updated file.

import { readSessionLedger, updateSessionLedger } from "./domain/session-ledger.mjs";
import { sessionKey, workspacePath } from "./storage.mjs";

export { workspacePath };

// Reads persisted runtime state.
export async function readState(workspacePath) {
    if (!workspacePath) {
        return undefined;
    }
    return (await readSessionLedger()).runtime[stateKey(workspacePath)];
}

// Applies a state patch and writes it when the session workspace is known.
export async function mergeState(workspacePath, patch = {}) {
    if (!workspacePath) {
        return applyPatch(undefined, patch);
    }

    let returned;
    await updateSessionLedger((ledger) => {
        const key = stateKey(workspacePath);
        const prior = ledger.runtime[key];
        const persisted = applyPatch(prior, persistedPatch(patch));
        returned = applyPatch(prior, patch);
        ledger.runtime[key] = persisted;
        return ledger;
    });
    return returned;
}

export function stateKey(workspacePath) {
    return sessionKey(workspacePath);
}

function applyPatch(state = {}, patch = {}) {
    const next = { ...state };
    for (const [key, value] of Object.entries(patch ?? {})) {
        if (value === undefined) {
            continue;
        }
        if (value === null) {
            delete next[key];
            continue;
        }
        next[key] = value;
    }
    return next;
}

function persistedPatch(patch = {}) {
    return Object.fromEntries(Object.entries(patch).filter(([key]) => !key.startsWith("window")));
}
