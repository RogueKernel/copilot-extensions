// Tiny finite-number helpers shared by domain and rendering modules.
// These functions make the "missing value" policy explicit: use num() when
// absence should behave like zero, and optNum() when absence must be preserved.

// Empty denominators are expected before token totals arrive.
export function pct(numerator, denominator) {
    return denominator > 0 ? (numerator / denominator) * 100 : 0;
}

// Missing ratios stay undefined so callers can preserve absence.
export function ratio(numerator, denominator) {
    return denominator > 0 ? numerator / denominator : undefined;
}

export function num(value) {
    return isFiniteNumber(value) ? value : 0;
}

export function optNum(value) {
    return isFiniteNumber(value) ? value : undefined;
}

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
