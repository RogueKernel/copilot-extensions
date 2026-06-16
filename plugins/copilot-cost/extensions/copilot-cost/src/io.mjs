// Small filesystem and stdin helpers shared by runtime adapters.
// This module is the filesystem seam: missing JSON files mean first-run state,
// but malformed JSON and other I/O errors still surface to the caller.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;

// Only first-run ENOENT is optional; malformed state should fail fast.
export async function readJson(filePath) {
    try {
        return JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
        if (error?.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}

// Keeps persisted state compact and safe for first-run directories.
export async function writeJson(filePath, value) {
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    try {
        await writeFile(tempPath, `${JSON.stringify(value)}\n`);
        await rename(tempPath, filePath);
    } catch (error) {
        await rm(tempPath, { force: true });
        throw error;
    }
}

// Serializes read-modify-write updates and writes the final JSON atomically.
export async function updateJson(filePath, updater) {
    return withJsonLock(filePath, async () => {
        const next = await updater(await readJson(filePath));
        await writeJson(filePath, next);
        return next;
    });
}

async function withJsonLock(filePath, operation) {
    const lockPath = `${filePath}.lock`;
    await mkdir(dirname(filePath), { recursive: true });
    await acquireLock(lockPath);
    try {
        return await operation();
    } finally {
        await rm(lockPath, { recursive: true, force: true });
    }
}

async function acquireLock(lockPath) {
    const startedAt = Date.now();
    while (true) {
        try {
            await mkdir(lockPath);
            return;
        } catch (error) {
            if (error?.code !== "EEXIST") {
                throw error;
            }
            await removeStaleLock(lockPath);
            if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
                throw new Error(`Timed out waiting for JSON lock: ${lockPath}`);
            }
            await sleep(LOCK_RETRY_MS);
        }
    }
}

async function removeStaleLock(lockPath) {
    try {
        const details = await stat(lockPath);
        if (Date.now() - details.mtimeMs > LOCK_STALE_MS) {
            await rm(lockPath, { recursive: true, force: true });
        }
    } catch (error) {
        if (error?.code !== "ENOENT") {
            throw error;
        }
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Statusline launches this module directly and sends its JSON payload via stdin.
export function readStdin() {
    return new Promise((resolve, reject) => {
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
            input += chunk;
        });
        process.stdin.on("end", () => resolve(input));
        process.stdin.on("error", reject);
    });
}

// Runtime aliases can be absent, non-string, or whitespace-only.
export function stringValue(value) {
    return typeof value === "string" && value.trim() ? value : undefined;
}
