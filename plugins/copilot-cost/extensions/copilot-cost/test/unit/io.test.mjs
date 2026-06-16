import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { readJson, stringValue, updateJson, writeJson } from "../../src/io.mjs";

test("readJson treats missing files as first-run state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "copilot-cost-io-"));

    assert.equal(await readJson(join(dir, "missing.json")), undefined);
});

test("writeJson creates parents and writes minified JSON with a trailing newline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "copilot-cost-io-"));
    const path = join(dir, "nested", "state.json");

    await writeJson(path, { totalUsd: 1, pendingUsd: 0.25 });

    assert.equal(await readFile(path, "utf8"), "{\"totalUsd\":1,\"pendingUsd\":0.25}\n");
    assert.deepEqual(await readJson(path), { totalUsd: 1, pendingUsd: 0.25 });
});

test("updateJson serializes updates and writes minified JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "copilot-cost-io-"));
    const path = join(dir, "state.json");
    await writeJson(path, { count: 0 });

    await Promise.all(Array.from({ length: 5 }, () => updateJson(path, (state) => ({
        count: state.count + 1,
    }))));

    assert.equal(await readFile(path, "utf8"), "{\"count\":5}\n");
});

test("readJson surfaces malformed JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "copilot-cost-io-"));
    const path = join(dir, "bad.json");
    await writeFile(path, "{");

    await assert.rejects(() => readJson(path), SyntaxError);
});

test("readStdin collects the full stdin payload", () => {
    const source = `
        import { readStdin } from "./src/io.mjs";
        process.stdout.write(JSON.stringify(await readStdin()));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
        cwd: new URL("../..", import.meta.url),
        input: "hello\nworld",
        encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), "hello\nworld");
});

test("stringValue returns only non-empty strings", () => {
    assert.equal(stringValue(" workspace "), " workspace ");
    assert.equal(stringValue(""), undefined);
    assert.equal(stringValue("   "), undefined);
    assert.equal(stringValue(42), undefined);
    assert.equal(stringValue(null), undefined);
});
