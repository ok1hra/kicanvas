/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { assert } from "chai";
import { no_self_recursion } from "../../src/base/functions";

class Node {
    calls = 0;
    other?: Node;

    @no_self_recursion
    poke() {
        this.calls++;
        // Recursing into the same object is blocked...
        this.poke();
        // ...but calling the same method on another object isn't recursion.
        this.other?.poke();
    }
}

suite("base.functions", function () {
    test("no_self_recursion is per instance", function () {
        const a = new Node();
        const b = new Node();
        a.other = b;
        b.other = a;

        a.poke();

        assert.equal(a.calls, 1);
        assert.equal(b.calls, 1);
    });
});
