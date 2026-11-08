import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {parseHTML} from "linkedom";

const source = fs.readFileSync(new URL("../ui/error-timer.js", import.meta.url), "utf8");

function fixture() {
    const {window, document} = parseHTML('<p id="status" role="status" hidden></p>');
    let now = 0, next = 0;
    const tasks = new Map();
    const setTimeout = (fn, delay) => { const id = ++next; tasks.set(id, {fn, at:now + delay}); return id; };
    const clearTimeout = id => tasks.delete(id);
    vm.runInNewContext(source, {window, document, setTimeout, clearTimeout, Date:{now:() => now}});
    const advance = ms => {
        const end = now + ms;
        while (true) {
            const due = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            now = due[1].at; tasks.delete(due[0]); due[1].fn();
        }
        now = end;
    };
    return {window, document, status:document.querySelector("#status"), timer:window.WarpErrorTimer, advance};
}

test("an error shows a countdown and clears after six seconds", () => {
    const f = fixture();
    f.timer.set(f.status, "Could not save", {error:true, hideWhenEmpty:true});
    assert.equal(f.status.hidden, false);
    assert.equal(f.status.classList.contains("timed-error"), true);
    assert.equal(f.status.style.getPropertyValue("--error-duration"), "6000ms");
    f.advance(5999);
    assert.equal(f.status.textContent, "Could not save");
    f.advance(1);
    assert.equal(f.status.textContent, "");
    assert.equal(f.status.hidden, true);
    assert.equal(f.status.classList.contains("error"), false);
});

test("a replacement error gets a fresh timer and a success message is retained", () => {
    const f = fixture();
    f.timer.set(f.status, "First error", {error:true});
    f.advance(4000);
    f.timer.set(f.status, "Second error", {error:true});
    f.advance(2000);
    assert.equal(f.status.textContent, "Second error");
    f.advance(4000);
    assert.equal(f.status.textContent, "");
    f.timer.set(f.status, "Another error", {error:true});
    f.advance(3000);
    f.timer.set(f.status, "Saved");
    f.advance(10000);
    assert.equal(f.status.textContent, "Saved");
});

test("hover and keyboard focus pause the countdown", () => {
    const f = fixture();
    f.timer.set(f.status, "Read this error", {error:true});
    assert.equal(f.status.getAttribute("tabindex"), "0");
    f.advance(4000);
    f.status.dispatchEvent(new f.window.Event("pointerenter"));
    assert.equal(f.status.classList.contains("timer-paused"), true);
    f.advance(20000);
    f.status.dispatchEvent(new f.window.Event("focusin"));
    f.status.dispatchEvent(new f.window.Event("pointerleave"));
    f.advance(20000);
    assert.equal(f.status.textContent, "Read this error");
    f.status.dispatchEvent(new f.window.Event("focusout"));
    f.advance(1999);
    assert.equal(f.status.textContent, "Read this error");
    f.advance(1);
    assert.equal(f.status.textContent, "");
    assert.equal(f.status.hasAttribute("tabindex"), false);
});
