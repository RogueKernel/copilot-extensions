// Shared adapter for runtime display/accounting state.
// Runtime state is kept in the versioned summary-state file so footer and after-message
// rendering avoid loading or rewriting the historical session ledger.

import { mergeRuntimeState, readRuntimeState } from "./summary-state.mjs";
import { sessionKey, workspacePath } from "./storage.mjs";

export { workspacePath };

// Reads persisted runtime state.
export async function readState(workspacePath) {
    return readRuntimeState(workspacePath);
}

// Applies a state patch and writes it when the session workspace is known.
export async function mergeState(workspacePath, patch = {}) {
    return mergeRuntimeState(workspacePath, patch);
}

export function stateKey(workspacePath) {
    return sessionKey(workspacePath);
}
