import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {parseHTML} from "linkedom";

test("radial labels remain separate for one through eight windows and title text cannot create markup", async () => {
    const {window,document} = parseHTML(fs.readFileSync(new URL("../ui/radial.html",import.meta.url),"utf8"));
    let update;
    const calls = [];
    window.__TAURI__ = {
        event:{listen:async (_name,callback)=>{update=callback;}},
        core:{invoke:async (command,args)=>{calls.push({command,args});return null;}}
    };
    vm.runInNewContext(fs.readFileSync(new URL("../ui/radial.js",import.meta.url),"utf8"),{window,document,console});
    await new Promise(resolve=>setImmediate(resolve));
    for (let count=1;count<=8;count++) {
        const labels = Array.from({length:count},(_,i)=>`<script>${i}</script> A very long window title`);
        update({payload:{id:"current",labels,selected:count-1}});
        assert.equal(document.querySelectorAll("[role=option]").length,count);
        assert.equal(document.querySelectorAll("[aria-selected=true]").length,1);
        assert.equal(document.querySelector("#slots script"),null);
        assert.equal(document.querySelector("[role=option]").getAttribute("aria-label"),labels[0]);
        const boxes=[...document.querySelectorAll("rect")].map(r=>Object.fromEntries(["x","y","width","height"].map(a=>[a,Number(r.getAttribute(a))])));
        for (const [i,a] of boxes.entries()) {
            assert.ok(a.x>=0 && a.y>=0 && a.x+a.width<=260 && a.y+a.height<=260);
            for (const b of boxes.slice(i+1)) {
                const overlap = Math.min(a.x+a.width,b.x+b.width)>Math.max(a.x,b.x) && Math.min(a.y+a.height,b.y+b.height)>Math.max(a.y,b.y);
                assert.equal(overlap,false,`overlap with ${count} windows`);
            }
        }
    }
    const escape = new window.Event("keydown");
    escape.key="Escape";
    document.dispatchEvent(escape);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),{command:"cancel_radial",args:{id:"current"}});
});
