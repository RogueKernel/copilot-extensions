---
applyTo: "README.md,plugins/copilot-cost/README.md,docs/copilot-cost/**,plugins/copilot-cost/extensions/copilot-cost/test/**,plugins/copilot-cost/extensions/copilot-cost/package*.json,plugins/copilot-cost/plugin.json,.github/plugin/marketplace.json"
---

# copilot-cost docs, tests, and release hygiene

- Keep user docs and architecture docs aligned with code changes in the same patch. Update `README.md`, `plugins/copilot-cost/README.md`, `docs/copilot-cost/usage.md`, `docs/copilot-cost/architecture.md`, `docs/copilot-cost/algorithms/`, and `docs/copilot-cost/development.md` when behavior changes.
- Use Mermaid diagrams in `docs/copilot-cost/architecture.md` for lifecycle and sync-flow changes when a prose-only update would hide important ordering or concurrency behavior.
- Keep `/cost` wording explicit that 24h/7d/30d/60d/90d/180d values are local retained telemetry, not account-wide Copilot billing or `/usage` data.
- When adding or changing user-visible metrics, tests should cover rendering, unit conversion, source/surface labeling, and docs should describe where the data comes from.
- Prefer focused unit tests near the changed module, then run `npm run validate` from `plugins/copilot-cost/extensions/copilot-cost` before finishing.
- There is no lint/build script. `npm run validate` runs `npm test`, `npm run check`, and `npm run smoke:statusline`.
- The extension version lives in `plugins/copilot-cost/extensions/copilot-cost/package.json`. When changing extension or plugin files for release, keep `package.json`, `package-lock.json`, `plugins/copilot-cost/plugin.json`, and `.github/plugin/marketplace.json` versions aligned.
- Keep diagnostic exports redacted. `COPILOT_COST_DEBUG.jsonl` and `debug-events.jsonl` should never be committed.
- Preserve GitHub Copilot CLI conventions: plugin-shipped native extension entrypoints live under `plugins/<plugin>/extensions/<name>/extension.mjs`, and scoped instructions under `.github/instructions/*.instructions.md` are intended for GitHub Copilot even if other agents ignore `applyTo`.
