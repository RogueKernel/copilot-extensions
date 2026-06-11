import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJsonc(path) {
    try {
        const raw = await readFile(path, "utf8");
        if (!raw.trim()) {
            return { existed: true, jsonc: false, value: {} };
        }
        try {
            return { existed: true, jsonc: false, value: JSON.parse(raw) };
        } catch (jsonError) {
            const stripped = stripJsonc(raw);
            try {
                return { existed: true, jsonc: stripped.changed, value: JSON.parse(stripped.text) };
            } catch {
                throw new Error(`Could not parse ${path}: ${jsonError.message}`);
            }
        }
    } catch (error) {
        if (error?.code === "ENOENT") {
            return { existed: false, jsonc: false, value: {} };
        }
        throw error;
    }
}

export async function writeJsonWithBackup(path, value, existed) {
    await mkdir(dirname(path), { recursive: true });
    if (existed) {
        const suffix = new Date().toISOString().replace(/[:.]/g, "-");
        await copyFile(path, `${path}.bak-${suffix}`);
    }
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temp, path);
}

function stripJsonc(input) {
    const withoutComments = stripComments(input);
    const withoutTrailingCommas = stripTrailingCommas(withoutComments.text);
    return {
        changed: withoutComments.changed || withoutTrailingCommas.changed,
        text: withoutTrailingCommas.text,
    };
}

function stripComments(input) {
    let output = "";
    let changed = false;
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;
    let escaped = false;

    for (let index = 0; index < input.length; index += 1) {
        const char = input[index];
        const next = input[index + 1];

        if (inLineComment) {
            if (char === "\n" || char === "\r") {
                inLineComment = false;
                output += char;
            } else {
                changed = true;
            }
            continue;
        }

        if (inBlockComment) {
            if (char === "*" && next === "/") {
                inBlockComment = false;
                index += 1;
            } else if (char === "\n" || char === "\r") {
                output += char;
            }
            changed = true;
            continue;
        }

        if (inString) {
            output += char;
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === "\"") {
                inString = false;
            }
            continue;
        }

        if (char === "\"") {
            inString = true;
            output += char;
        } else if (char === "/" && next === "/") {
            inLineComment = true;
            changed = true;
            index += 1;
        } else if (char === "/" && next === "*") {
            inBlockComment = true;
            changed = true;
            index += 1;
        } else {
            output += char;
        }
    }

    return { changed, text: output };
}

function stripTrailingCommas(input) {
    let output = "";
    let changed = false;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < input.length; index += 1) {
        const char = input[index];

        if (inString) {
            output += char;
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === "\"") {
                inString = false;
            }
            continue;
        }

        if (char === "\"") {
            inString = true;
            output += char;
            continue;
        }

        if (char === ",") {
            let nextIndex = index + 1;
            while (/\s/.test(input[nextIndex] ?? "")) {
                nextIndex += 1;
            }
            if (input[nextIndex] === "}" || input[nextIndex] === "]") {
                changed = true;
                continue;
            }
        }

        output += char;
    }

    return { changed, text: output };
}
