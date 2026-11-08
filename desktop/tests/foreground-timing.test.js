import {test} from "node:test";
import assert from "node:assert/strict";
import {summarizeForeground} from "./windows/foreground-timing.mjs";

test("foreground timing correlates only a complete matching transition sequence", () => {
    const expected = [1, 2, 1];
    const releases = [100, 200, 300];
    assert.deepEqual(summarizeForeground(expected, releases, [[1, 110], [2, 220], [1, 330]]), {
        observed: [1, 2, 1], latencyMs: [10, 20, 30],
    });
    for (const events of [
        [[1, 110], [1, 330]],
        [[1, 110], [2, 220], [2, 240], [1, 330]],
        [[2, 110], [1, 220], [1, 330]],
    ]) assert.equal(summarizeForeground(expected, releases, events).latencyMs, null);
    assert.equal(summarizeForeground(expected, releases.slice(0, 2), [[1, 110], [2, 220], [1, 330]]).latencyMs, null);
});
