# Backlog

## Copilot Cost Accounting

### Investigate cache-write treatment for previous-turn output

The next-message estimator now samples priced cache-write tokens separately from
ordinary uncached input. A remaining question is whether output tokens from the
previous turn become part of the next turn's cache-created context and therefore
also incur cache-write pricing on models that charge for cache creation.

Initial investigation:

- GitHub's pricing docs split usage into input tokens, output tokens, and cached
  tokens, and list an extra `Cache write` column for Anthropic models:
  https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
- Anthropic describes prompt caching as caching the prompt prefix, with cache
  writes priced as a multiplier of input-token price:
  https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- That suggests generated output is not cache-written on the same response.
  However, when the next request includes prior assistant output in its message
  history, that text has become prompt/context input. It may then be counted as
  cache-read or cache-write input by the provider.

Current code behavior:

- Runtime turn collection is payload-driven. It records `inputTokens`,
  `outputTokens`, `cacheReadTokens`, raw `cacheWriteTokens`, and separately
  counts priced cache-write token-detail rows.
- The next-message estimator samples:

  ```text
  uncachedInputTokens = max(0, inputTokens - cacheReadTokens - cacheWriteTokens)
  cacheWriteTokens = pricedCacheWriteTokens
  outputTokens = outputTokens
  ```

- Historical token estimates use the same separation: cache reads and cache
  writes are priced as their own token classes, and only the remainder of
  `inputTokens` is treated as ordinary uncached input.
- The code does not infer cache-write tokens from previous-turn output. It only
  uses `cacheWriteTokens` and priced cache-write token details that Copilot or
  VS Code telemetry actually report.

Example to validate:

```text
Turn N:
  outputTokens = 1,000

Turn N+1 payload, if previous output is cache-created as prompt context:
  inputTokens = 6,000
  cacheReadTokens = 4,000
  cacheWriteTokens = 1,200
  outputTokens = 500
```

In that shape, current code should already account for the previous output as
part of Turn N+1's priced `cacheWriteTokens`. Manually adding Turn N's output
again would double-count.

Risk:

- If Copilot already reports prior assistant output inside next-turn
  `cacheWriteTokens`, current code is correct.
- If Copilot bills cache creation for prior assistant output but does not expose
  it in `cacheWriteTokens` or token details, the next-message estimate may
  understate cache-write-heavy models.
- If we add previous output heuristically without proving the payload shape, we
  risk double-counting because the same text can be both prior output and later
  prompt/context input.

Suggested approach:

1. Keep the current release behavior payload-driven.
2. Capture a small redacted debug sample for 3-5 consecutive Claude/Anthropic
   turns with cache-write pricing enabled.
3. For each adjacent turn pair, compare Turn N `outputTokens` with Turn N+1
   `cacheWriteTokens`, `cacheReadTokens`, and model-metrics totals.
4. Validate the summed class costs against shutdown/model-metrics totals.
5. Only change the estimator if there is clear evidence that billed cache writes
   are missing from exposed `cacheWriteTokens`.

Opinion: do not infer previous-output cache writes for v1.1.1. The provider
payload is the safer source of truth, and the current estimator is already
correct for the most likely exposed shape where prior output, if cached later,
appears as next-turn cache-write input.
