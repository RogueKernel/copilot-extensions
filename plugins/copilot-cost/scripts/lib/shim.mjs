import { lstat, mkdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import {
    GENERATED_MARKER,
    assertBundledExtension,
    userExtensionDirectory,
    userExtensionEntrypoint,
} from "./paths.mjs";

export async function installExtensionShim({ copilotHome, pluginRoot }) {
    const sourceExtension = await assertBundledExtension(pluginRoot);
    const targetDirectory = userExtensionDirectory(copilotHome);
    const targetExtension = userExtensionEntrypoint(copilotHome);
    const content = renderExtensionShim(sourceExtension);

    await prepareTargetDirectory(targetDirectory);

    try {
        const existing = await readFile(targetExtension, "utf8");
        if (existing === content) {
            return { targetExtension, sourceExtension, content, changed: false };
        }
        if (!existing.includes(GENERATED_MARKER)) {
            throw new Error(`Refusing to overwrite unmanaged native extension at ${targetExtension}`);
        }
    } catch (error) {
        if (error?.code !== "ENOENT") {
            throw error;
        }
    }

    await mkdir(dirname(targetExtension), { recursive: true });
    await writeFile(targetExtension, content);
    return { targetExtension, sourceExtension, content, changed: true };
}

export async function uninstallExtensionShim({ copilotHome }) {
    const targetDirectory = userExtensionDirectory(copilotHome);
    const targetExtension = userExtensionEntrypoint(copilotHome);

    try {
        const existing = await readFile(targetExtension, "utf8");
        if (!existing.includes(GENERATED_MARKER)) {
            return { removed: false, reason: `Skipped unmanaged native extension at ${targetExtension}` };
        }
    } catch (error) {
        if (error?.code === "ENOENT") {
            return { removed: false, reason: "No managed native extension shim was installed" };
        }
        throw error;
    }

    await rm(targetDirectory, { recursive: true, force: true });
    return { removed: true, targetDirectory };
}

function renderExtensionShim(sourceExtension) {
    return `// ${GENERATED_MARKER}\nimport { pathToFileURL } from "node:url";\n\nawait import(pathToFileURL(${JSON.stringify(sourceExtension)}).href);\n`;
}

async function prepareTargetDirectory(targetDirectory) {
    try {
        const entry = await lstat(targetDirectory);
        if (entry.isSymbolicLink()) {
            await replaceLegacySymlink(targetDirectory);
            return;
        }
        if (!entry.isDirectory()) {
            throw new Error(`Refusing to replace non-directory at ${targetDirectory}`);
        }
    } catch (error) {
        if (error?.code !== "ENOENT") {
            throw error;
        }
    }
}

async function replaceLegacySymlink(targetDirectory) {
    const linkTarget = await readlink(targetDirectory);
    const resolved = await realpath(targetDirectory);
    const plausibleCopilotCostTarget = resolved.includes("copilot-cost") || linkTarget.includes("copilot-cost");
    if (!plausibleCopilotCostTarget) {
        throw new Error(`Refusing to replace unmanaged symlink at ${targetDirectory} -> ${linkTarget}`);
    }
    await rm(targetDirectory, { force: true });
}

export const testExports = { renderExtensionShim };
