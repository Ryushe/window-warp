// A latency belongs to a press only if the complete observed foreground
// sequence matches the expected press sequence. Missing, extra or reordered
// foreground events make index-based latency attribution misleading.
export function summarizeForeground(expected, releases, events) {
    const observed = events.map(([window]) => window);
    const matched = releases.length === expected.length && observed.length === expected.length &&
        observed.every((window, index) => window === expected[index]);
    return {
        observed,
        latencyMs: matched ? events.map(([, observedAt], index) => observedAt - releases[index]) : null,
    };
}
