// Accumulates assistant usage events into one completed turn.
// The runtime owns event ordering; this module owns Turn, the mutable in-memory
// accumulator with a real lifecycle (start, collect, finish) that later becomes
// a durable cost snapshot. createTurn/collect stay the module's stable seam so
// the runtime and tests keep injecting them without depending on the class.

import { num, optNum } from "../math.mjs";
import {
    countCacheWrites,
    isCacheReadToken,
    isCacheWriteToken,
    isInputToken,
    isOutputToken,
    measureRate,
} from "./rates.mjs";
import { timestampMs } from "../render/format.mjs";

// One assistant turn under construction. Fields stay public because the runtime
// drives lifecycle moments (startedAt, turnId, done, endedAt) directly, while
// token, rate, and cost accumulation lives in this object's own behavior.
class Turn {
    constructor() {
        this.events = 0;
        this.input = 0;
        this.output = 0;
        this.cacheRead = 0;
        this.cacheWrite = 0;
        this.pricedCacheWrite = 0;
        this.inputNanoPerToken = undefined;
        this.cacheReadNanoPerToken = undefined;
        this.cacheWriteNanoPerToken = undefined;
        this.outputNanoPerToken = undefined;
        this.nanoAiu = 0;
        this.partial = false;
        this.done = false;
        // Lifecycle fields the runtime sets as the turn starts and ends.
        this.startedAt = undefined;
        this.endedAt = undefined;
        this.turnId = undefined;
    }

    // Folds one assistant usage event into this turn.
    collect(event) {
        const usage = event.data;
        this.startedAt ??= timestampMs(event.timestamp) ?? Date.now();
        this.events += 1;

        this.#collectTokens(usage);
        this.#collectRates(usage);
        this.#collectOfficialCost(usage);
    }

    // Sums token counts, including priced cache writes.
    #collectTokens(usage) {
        this.input += num(usage.inputTokens);
        this.output += num(usage.outputTokens);
        this.cacheRead += num(usage.cacheReadTokens);
        this.cacheWrite += num(usage.cacheWriteTokens);
        this.pricedCacheWrite += countCacheWrites(usage);
    }

    // Tracks the latest per-token rate seen for each token class.
    #collectRates(usage) {
        this.inputNanoPerToken = Turn.#latestRate(usage, isInputToken, this.inputNanoPerToken);
        this.cacheReadNanoPerToken = Turn.#latestRate(usage, isCacheReadToken, this.cacheReadNanoPerToken);
        this.cacheWriteNanoPerToken = Turn.#latestRate(usage, isCacheWriteToken, this.cacheWriteNanoPerToken);
        this.outputNanoPerToken = Turn.#latestRate(usage, isOutputToken, this.outputNanoPerToken);
    }

    // Adds official cost, marking the turn partial when cost data is missing.
    #collectOfficialCost(usage) {
        const nanoAiu = optNum(usage.copilotUsage?.totalNanoAiu);
        if (nanoAiu === undefined) {
            this.partial = true;
            return;
        }

        this.nanoAiu += nanoAiu;
        if (this.#hasUnpricedCacheWrite()) {
            this.partial = true;
        }
    }

    // Cache writes happened but none carried a price, so the cost is incomplete.
    #hasUnpricedCacheWrite() {
        return this.cacheWrite > 0 && this.pricedCacheWrite === 0;
    }

    // Prefers a freshly measured rate, otherwise keeps the prior one.
    static #latestRate(usage, predicate, priorRate) {
        return measureRate(usage, predicate) ?? priorRate;
    }
}

// Creates a fresh mutable turn accumulator.
export function createTurn() {
    return new Turn();
}

// Adds one assistant usage event into the active turn accumulator.
export function collect(turn, event) {
    turn.collect(event);
}
