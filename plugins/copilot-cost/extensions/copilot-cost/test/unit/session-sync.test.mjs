import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    currentSessionId,
    discoverSessionEventFiles,
    syncSessionLedger,
} from "../../src/domain/session-sync.mjs";
import {
    SOURCE_ESTIMATED_TOKENS,
    SOURCE_SHUTDOWN,
    SOURCE_STATUSLINE,
    SOURCE_USAGE_EVENTS,
    STATE_AUTO_CLOSED,
    STATE_CLOSED,
    STATE_OPEN,
} from "../../src/domain/session-ledger.mjs";

const day = 24 * 60 * 60 * 1000;

test("syncSessionLedger parses only new sessions and classifies closed/open/auto_closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await writeEvents(root, "closed", [
        event("session.shutdown", now - day, {
            totalNanoAiu: 2_000_000_000,
            modelMetrics: {
                "gpt-test": {
                    totalNanoAiu: 2_000_000_000,
                    usage: { inputTokens: 100 },
                },
            },
        }),
    ]);
    await writeEvents(root, "recent", [
        event("assistant.usage", now - 1_000, {
            model: "gpt-test",
            inputTokens: 10,
            copilotUsage: { totalNanoAiu: 100_000_000 },
        }),
    ]);
    await writeEvents(root, "stale", [
        event("assistant.usage", now - 8 * day, {
            model: "gpt-test",
            inputTokens: 50,
        }),
    ]);

    const ledger = await syncSessionLedger({ currentSessionId: "current", sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions.current.state, STATE_OPEN);
    assert.equal(ledger.sessions.closed.state, STATE_CLOSED);
    assert.equal(ledger.sessions.closed.source, SOURCE_SHUTDOWN);
    assert.equal(ledger.sessions.closed.totalNanoAiu, 2_000_000_000);
    assert.equal(ledger.sessions.recent.state, STATE_OPEN);
    assert.equal(ledger.sessions.recent.source, SOURCE_USAGE_EVENTS);
    assert.equal(ledger.sessions.recent.totalNanoAiu, 100_000_000);
    assert.equal(ledger.sessions.stale.state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions.stale.source, SOURCE_ESTIMATED_TOKENS);
    assert.equal(ledger.sessions.stale.totalNanoAiu, 1_000_000_000);
});

test("syncSessionLedger does not re-aggregate known open sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await writeFile(ledgerPath, JSON.stringify({
        version: 1,
        sessions: {
            known: {
                id: "known",
                state: STATE_OPEN,
                totalNanoAiu: 123,
                source: SOURCE_STATUSLINE,
                lastSeenAt: now - 8 * day,
                lastUpdatedAt: now - 7 * day,
            },
        },
    }));
    await writeEvents(root, "known", [
        event("session.shutdown", now - day, { totalNanoAiu: 999_000_000_000 }),
    ]);

    const ledger = await syncSessionLedger({ sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions.known.state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions.known.source, SOURCE_STATUSLINE);
    assert.equal(ledger.sessions.known.totalNanoAiu, 123);
    assert.equal(ledger.sessions.known.lastUpdatedAt, now - 7 * day);
});

test("syncSessionLedger scans new sessions within the 180-day retention horizon", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 11, 1, 12);
    await writeEvents(root, "within-history", [
        event("session.shutdown", now - 179 * day, { totalNanoAiu: 1_000_000_000 }),
    ]);
    await writeEvents(root, "outside-history", [
        event("session.shutdown", now - 181 * day, { totalNanoAiu: 2_000_000_000 }),
    ]);
    await touch(join(root, "within-history", "events.jsonl"), now - 179 * day);
    await touch(join(root, "outside-history", "events.jsonl"), now - 181 * day);

    const ledger = await syncSessionLedger({ sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions["within-history"].state, STATE_CLOSED);
    assert.equal(ledger.sessions["within-history"].totalNanoAiu, 1_000_000_000);
    assert.equal(ledger.sessions["outside-history"], undefined);
});

test("syncSessionLedger values pre-usage-based sessions from retained token profiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    const ledgerPath = join(await mkdtemp(join(tmpdir(), "copilot-cost-data-")), "session-ledger.json");
    const now = Date.UTC(2026, 5, 10, 12);
    await writeEvents(root, "priced", [
        event("session.shutdown", Date.UTC(2026, 5, 2, 12), {
            totalNanoAiu: 1_000_000_000,
            modelMetrics: {
                "gpt-test": {
                    totalNanoAiu: 1_000_000_000,
                    usage: { outputTokens: 100 },
                },
            },
        }),
    ]);
    await writeEvents(root, "pre-pricing", [
        event("session.shutdown", Date.UTC(2026, 4, 31, 12), {
            totalNanoAiu: 50_000_000_000,
            modelMetrics: {
                "gpt-test": {
                    totalNanoAiu: 50_000_000_000,
                    usage: { outputTokens: 50 },
                },
            },
        }),
    ]);
    await touch(join(root, "priced", "events.jsonl"), Date.UTC(2026, 5, 2, 12));
    await touch(join(root, "pre-pricing", "events.jsonl"), Date.UTC(2026, 4, 31, 12));

    const ledger = await syncSessionLedger({ sessionStateRoot: root, ledgerPath, now });

    assert.equal(ledger.sessions.priced.state, STATE_CLOSED);
    assert.equal(ledger.sessions["pre-pricing"].state, STATE_AUTO_CLOSED);
    assert.equal(ledger.sessions["pre-pricing"].source, SOURCE_ESTIMATED_TOKENS);
    assert.equal(ledger.sessions["pre-pricing"].totalNanoAiu, 500_000_000);
});

test("discoverSessionEventFiles ignores missing roots and sorts newest first", async () => {
    assert.deepEqual(await discoverSessionEventFiles(join(tmpdir(), "missing-copilot-session-root")), []);

    const root = await mkdtemp(join(tmpdir(), "copilot-cost-session-state-"));
    await writeEvents(root, "older", [event("session.shutdown", Date.UTC(2026, 5, 1), {})]);
    await writeEvents(root, "newer", [event("session.shutdown", Date.UTC(2026, 5, 2), {})]);
    await touch(join(root, "older", "events.jsonl"), Date.UTC(2026, 5, 1));
    await touch(join(root, "newer", "events.jsonl"), Date.UTC(2026, 5, 2));

    assert.deepEqual((await discoverSessionEventFiles(root)).map((file) => file.id), ["newer", "older"]);
});

test("currentSessionId prefers explicit ids and otherwise reads session-state paths", () => {
    assert.equal(currentSessionId({ sessionId: "explicit" }), "explicit");
    assert.equal(currentSessionId({ id: "fallback" }), "fallback");
    assert.equal(currentSessionId({ workspacePath: "/tmp/session-state/abc" }), "abc");
    assert.equal(currentSessionId({ workspacePath: "/tmp/project" }), undefined);
});

async function writeEvents(root, id, events) {
    const dir = join(root, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "events.jsonl"), `${events.map((item) => JSON.stringify(item)).join("\n")}\n`);
}

function event(type, timestamp, data) {
    return { type, timestamp: new Date(timestamp).toISOString(), data };
}

async function touch(path, at) {
    const date = new Date(at);
    await utimes(path, date, date);
    await readFile(path);
}
