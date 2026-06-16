# copilot-cost algorithms

These pages document the small accounting algorithms that affect user-visible numbers. Keep them close to the implementation in `plugins/copilot-cost/extensions/copilot-cost/src/domain/`.

| Algorithm | Purpose |
| --- | --- |
| [`next-message-cost-estimate.md`](next-message-cost-estimate.md) | Explains the after-message `Next >= [low - high]` estimate. |
| [`historical-cost.md`](historical-cost.md) | Explains how `/cost` history and cached 24h/7d/30d windows are calculated. |
