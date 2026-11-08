import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {spawn} from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {authorization, ensurePrivacyPolicy, plan, prepare, sourceFingerprint, submissionDecision} from "../scripts/firefox-release.mjs";

const response = (status, body) => ({status, ok:status >= 200 && status < 300, json:async()=>body});
const args = {id:"window-warp@ryushe.local",version:"0.1.8",fingerprint:"a".repeat(64),apiKey:"test-key",apiSecret:"test-secret"};
const listed = (fingerprint = args.fingerprint, status = "public") => ({channel:"listed",file:{status},approval_notes:`Reviewer notes\n\nWindow Warp source SHA-256: ${fingerprint}`});

test("Firefox release workflow packages for manual submission without uploading", async () => {
    const workflow=await fs.readFile(new URL("../../.github/workflows/firefox-addon.yml",import.meta.url),"utf8");
    assert.match(workflow,/web-ext build/);
    assert.match(workflow,/actions\/upload-artifact/);
    assert.doesNotMatch(workflow,/web-ext sign|firefox-release\.mjs\s+(?:plan|policy)|AMO_JWT_/);
});

async function temporary(t) {
    const parent = path.resolve(os.tmpdir());
    const root = await fs.mkdtemp(path.join(parent, "warp-firefox-release-"));
    t.after(async()=>{
        if (path.dirname(root) !== parent || !path.basename(root).startsWith("warp-firefox-release-")) throw new Error("Unexpected temporary path");
        await fs.rm(root, {recursive:true, force:true});
    });
    return root;
}

test("Firefox release stages the actual extension files and MIT notice", async t => {
    const root = await temporary(t);
    const source = await prepare(path.join(root, "release"));
    const manifest = JSON.parse(await fs.readFile(path.join(source,"manifest.json"),"utf8"));
    assert.equal(manifest.browser_specific_settings.gecko.id,args.id);
    for (const file of ["background.js","popup.js","popup.html","popup.css","icon.png","LICENSE"]) {
        assert.ok((await fs.stat(path.join(source,file))).size > 0, file);
    }
    assert.match(await fs.readFile(path.join(source,"LICENSE"),"utf8"),/^MIT License/);
    assert.equal((await fs.readdir(source)).includes("warp-managed.json"),false);
    const before = await sourceFingerprint(source);
    assert.equal(before,await sourceFingerprint(source));
    await fs.appendFile(path.join(source,"popup.js"),"\n// changed\n");
    assert.notEqual(await sourceFingerprint(source),before);
});

test("Mozilla authorization uses a short-lived signed token", () => {
    const token = authorization(args.apiKey,args.apiSecret,1000);
    const [header,payload,signature] = token.slice(4).split(".");
    assert.deepEqual(JSON.parse(Buffer.from(header,"base64url")),{alg:"HS256",typ:"JWT"});
    const claims = JSON.parse(Buffer.from(payload,"base64url"));
    assert.equal(claims.iss,args.apiKey); assert.equal(claims.iat,1000); assert.equal(claims.exp,1060);
    assert.ok(claims.jti);
    assert.equal(signature,createHmac("sha256",args.apiSecret).update(`${header}.${payload}`).digest("base64url"));
    assert.throws(()=>authorization("", ""),/AMO_JWT_ISSUER/);
});

test("a new listing gets MIT metadata and a source fingerprint", async t => {
    const root = await temporary(t), output = path.join(root,"release");
    await prepare(output);
    const commit="a".repeat(40);
    const result = await plan(output,args.apiKey,args.apiSecret,async()=>response(404),commit);
    assert.equal(result.submit,true); assert.equal(result.initial,true);
    const metadata = JSON.parse(await fs.readFile(path.join(output,"amo-metadata.json"),"utf8"));
    assert.deepEqual(metadata.categories,["tabs"]); assert.equal(metadata.version.license,"MIT");
    assert.ok(metadata.version.approval_notes.includes(`Window Warp source SHA-256: ${result.fingerprint}`));
    assert.ok(metadata.description["en-US"].includes(`/blob/${commit}/Privacy%20Policy.txt`));
});

test("updates do not overwrite the existing listing description", async t => {
    const root=await temporary(t), output=path.join(root,"release"); await prepare(output);
    const result=await plan(output,args.apiKey,args.apiSecret,async()=>response(200,{results:[],next:null}));
    assert.equal(result.submit,true); assert.equal(result.initial,false);
    const metadata=JSON.parse(await fs.readFile(path.join(output,"amo-metadata.json"),"utf8"));
    assert.deepEqual(Object.keys(metadata),["version"]);
    assert.equal(metadata.version.license,"MIT");
});

test("an unchanged listed version is skipped, including one awaiting review", async () => {
    for (const status of ["public","unreviewed"]) {
        const requests=[];
        const request=async(url,options)=>{
            requests.push({url:String(url),options});
            return requests.length===1 ? response(200,{results:[{id:123,version:args.version}],next:null}) : response(200,listed(args.fingerprint,status));
        };
        assert.deepEqual(await submissionDecision({...args,request}),{submit:false,initial:false});
        assert.match(requests[0].url,/filter=all_with_unlisted/);
        assert.ok(requests.every(item=>item.options.redirect === "error" && item.options.headers.Authorization.startsWith("JWT ")));
    }
});

test("a new version is submitted, while a reused version with different source fails", async () => {
    const empty=async()=>response(200,{results:[],next:null});
    assert.deepEqual(await submissionDecision({...args,request:empty}),{submit:true,initial:false});
    let count=0;
    const mismatch=async()=>++count===1 ? response(200,{results:[{id:123,version:args.version}],next:null}) : response(200,listed("b".repeat(64)));
    await assert.rejects(submissionDecision({...args,request:mismatch}),/different or unverified source/);
});

test("an unavailable or differently distributed version is not silently skipped", async () => {
    const denied=async()=>response(401,{});
    await assert.rejects(submissionDecision({...args,request:denied}),/HTTP 401/);
    for (const record of [{...listed(),channel:"unlisted"},listed(args.fingerprint,"disabled")]) {
        let count=0;
        const request=async()=>++count===1 ? response(200,{results:[{id:123,version:args.version}],next:null}) : response(200,record);
        await assert.rejects(submissionDecision({...args,request}),/not an active listed version/);
    }
});

test("pagination stays on Mozilla's exact versions endpoint", async () => {
    let calls=0;
    const next="https://addons.mozilla.org/api/v5/addons/addon/window-warp@ryushe.local/versions/?page=2";
    const request=async()=>++calls===1 ? response(200,{results:[],next}) : response(200,{results:[],next:null});
    assert.deepEqual(await submissionDecision({...args,request}),{submit:true,initial:false});
    const hostile=async()=>response(200,{results:[],next:"https://example.com/steal"});
    await assert.rejects(submissionDecision({...args,request:hostile}),/unexpected versions page/);
});

test("the approved policy is added only when the listing lacks one", async () => {
    const requests=[];
    const missing=async(url,options)=>{
        requests.push({url:String(url),options});
        return requests.length === 1 ? response(200,{privacy_policy:null}) : response(200,{});
    };
    assert.equal(await ensurePrivacyPolicy({...args,policy:"Our policy",request:missing}),true);
    assert.equal(requests[1].options.method,"PATCH");
    assert.deepEqual(JSON.parse(requests[1].options.body),{privacy_policy:{"en-US":"Our policy"}});
    assert.ok(requests.every(item=>item.options.redirect === "error"));
    let calls=0;
    const existing=async()=>{calls++;return response(200,{privacy_policy:{"en-US":"Existing policy"}});};
    assert.equal(await ensurePrivacyPolicy({...args,policy:"Our policy",request:existing}),false);
    assert.equal(calls,1);
    let failedCalls=0;
    const failed=async()=>++failedCalls === 1 ? response(200,{privacy_policy:null}) : response(503,{});
    await assert.rejects(ensurePrivacyPolicy({...args,policy:"Our policy",request:failed}),/HTTP 503.*rerun/i);
});

test("the real web-ext command submits the prepared listing to a local mock", async t => {
    const root=await temporary(t), output=path.join(root,"release");
    await prepare(output);
    const prepared=await plan(output,args.apiKey,args.apiSecret,async()=>response(404),"a".repeat(40));
    let submission;
    const server=http.createServer(async (req,res)=>{
        const chunks=[]; for await (const chunk of req) chunks.push(chunk);
        const target=decodeURIComponent(req.url);
        let result;
        if (req.method === "POST" && target === "/api/v5/addons/upload/") result={uuid:"mock-upload"};
        else if (req.method === "GET" && target === "/api/v5/addons/upload/mock-upload/") result={uuid:"mock-upload",processed:true,valid:true,validation:{messages:[]}};
        else if (req.method === "PUT" && target === `/api/v5/addons/addon/${args.id}/`) {
            submission=JSON.parse(Buffer.concat(chunks).toString("utf8"));
            result={version:{id:42,edit_url:"http://127.0.0.1/mock-version"}};
        } else {res.writeHead(404);res.end();return;}
        res.writeHead(200,{"Content-Type":"application/json"}); res.end(JSON.stringify(result));
    });
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    const url=`http://127.0.0.1:${server.address().port}/api/v5/`;
    const cli=fileURLToPath(new URL("../node_modules/web-ext/bin/web-ext.js",import.meta.url));
    const command=[cli,"sign","--source-dir",path.join(output,"extension"),"--artifacts-dir",path.join(output,"artifacts"),
        "--amo-base-url",url,"--channel","listed","--amo-metadata",path.join(output,"amo-metadata.json"),
        "--approval-timeout","0","--no-config-discovery"];
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("WEB_EXT_")));
    Object.assign(env,{NO_UPDATE_NOTIFIER:"1",WEB_EXT_API_KEY:args.apiKey,WEB_EXT_API_SECRET:args.apiSecret});
    const child=spawn(process.execPath,command,{env,timeout:20000});
    let logs=""; child.stdout.on("data",chunk=>{logs+=chunk;}); child.stderr.on("data",chunk=>{logs+=chunk;});
    const exit=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});
    assert.equal(exit,0,logs);
    assert.equal(submission.version.upload,"mock-upload");
    assert.equal(submission.version.license,"MIT");
    assert.match(submission.version.approval_notes,new RegExp(prepared.fingerprint));
    assert.deepEqual(submission.categories,["tabs"]);
});
