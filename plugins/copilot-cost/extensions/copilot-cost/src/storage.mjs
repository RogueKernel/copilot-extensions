// Owns copilot-cost persistence paths.
// Product data lives under Copilot's per-plugin data directory; Copilot-owned
// settings and extension discovery files remain in their normal Copilot paths.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { stringValue } from "./io.mjs";

const MARKETPLACE_NAME = "copilot-extensions";
const PLUGIN_NAME = "copilot-cost";
export function copilotHome() {
    return resolve(process.env.COPILOT_HOME || join(homedir(), ".copilot"));
}

export function pluginDataDirectory() {
    return resolve(process.env.COPILOT_PLUGIN_DATA || join(copilotHome(), "plugin-data", MARKETPLACE_NAME, PLUGIN_NAME));
}

export function copilotSettingsPath() {
    return join(copilotHome(), "settings.json");
}

export function settingsPath() {
    return join(pluginDataDirectory(), "settings.json");
}

export function sessionLedgerPath() {
    return join(pluginDataDirectory(), "session-ledger.json");
}

export function sessionStateRootPath() {
    return join(copilotHome(), "session-state");
}

// Finds the session workspace from statusline payload variants.
export function workspacePath(status = {}) {
    const id = sessionId(status);
    const workspace = stringValue(status.workspace_path)
        ?? stringValue(status.workspacePath)
        ?? stringValue(status.session_workspace_path)
        ?? stringValue(status.sessionWorkspacePath);
    if (workspace) {
        return sessionScoped(workspace, id);
    }

    const transcriptPath = stringValue(status.transcript_path) ?? stringValue(status.transcriptPath);
    if (transcriptPath) {
        return sessionScoped(dirname(transcriptPath), id);
    }
    return id ? join(copilotHome(), "session-state", id) : undefined;
}

export function sessionKey(workspacePath) {
    const normalized = resolve(workspacePath);
    const label = sanitizeSegment(basename(normalized)) || "session";
    const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
    return `${label}-${hash}`;
}

// Reads the session id across payload key spellings.
export function sessionId(status = {}) {
    return stringValue(status.session_id) ?? stringValue(status.sessionId);
}

// Scopes a bare session-state root down to the active session's directory.
function sessionScoped(workspace, id) {
    const isSessionStateRoot = Boolean(id) && (basename(workspace) === "session-state");
    return isSessionStateRoot ? join(workspace, id) : workspace;
}

function sanitizeSegment(value) {
    return String(value ?? "").replace(/[^A-Za-z0-9._-]/g, "-");
}
