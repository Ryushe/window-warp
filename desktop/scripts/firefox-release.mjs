import {createHash, createHmac, randomUUID} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const extensionRoot = fileURLToPath(new URL("../browser-extension/", import.meta.url));
const privacyPolicyPath = fileURLToPath(new URL("../../Privacy Policy.txt", import.meta.url));
const amoRoot = new URL("https://addons.mozilla.org/api/v5/");
const markerPrefix = "Window Warp source SHA-256: ";

export async function prepare(outputDirectory) {
    const output = path.resolve(outputDirectory);
    const source = path.join(output, "extension");
    await fs.mkdir(output);
    await fs.cp(path.join(extensionRoot, "common"), source, {recursive:true, errorOnExist:true, force:false});
    await fs.copyFile(path.join(extensionRoot, "firefox-manifest.json"), path.join(source, "manifest.json"));
    await fs.copyFile(path.join(extensionRoot, "FIREFOX-LICENSE"), path.join(source, "LICENSE"));
    return source;
}

export async function sourceFingerprint(directory) {
    const hash = createHash("sha256");
    async function visit(relative = "") {
        const entries = await fs.readdir(path.join(directory, relative), {withFileTypes:true});
        entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        for (const entry of entries) {
            const name = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory()) await visit(name);
            else if (entry.isFile()) {
                const data = await fs.readFile(path.join(directory, name));
                hash.update(`${name}\0${data.length}\0`); hash.update(data);
            } else throw new Error(`Unsupported file in Firefox extension: ${name}`);
        }
    }
    await visit();
    return hash.digest("hex");
}

export function authorization(apiKey, apiSecret, now = Math.floor(Date.now() / 1000)) {
    if (!apiKey || !apiSecret) throw new Error("Set both AMO_JWT_ISSUER and AMO_JWT_SECRET in GitHub Actions secrets.");
    const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
    const body = `${encode({alg:"HS256",typ:"JWT"})}.${encode({iss:apiKey,jti:randomUUID(),iat:now,exp:now+60})}`;
    return `JWT ${body}.${createHmac("sha256", apiSecret).update(body).digest("base64url")}`;
}

export async function submissionDecision({id, version, fingerprint, apiKey, apiSecret, request = fetch}) {
    if (!id || !version) throw new Error("The Firefox manifest needs a stable extension ID and version.");
    const headers = {Accept:"application/json", Authorization:authorization(apiKey, apiSecret)};
    const addonPath = `addons/addon/${encodeURIComponent(id)}/`;
    let next = new URL(`${addonPath}versions/`, amoRoot);
    const versionsPath = decodeURIComponent(next.pathname);
    next.searchParams.set("filter", "all_with_unlisted");
    next.searchParams.set("page_size", "50");
    const visited = new Set();
    let first = true;
    async function get(url) {
        let response;
        try { response = await request(url, {headers, redirect:"error", signal:AbortSignal.timeout(20000)}); }
        catch (error) { throw new Error(`Could not check the Firefox extension on Mozilla: ${error.message}`, {cause:error}); }
        if (!response.ok) return {status:response.status};
        return {status:response.status, body:await response.json()};
    }
    while (next) {
        if (next.origin !== amoRoot.origin || decodeURIComponent(next.pathname) !== versionsPath || visited.has(next.href)) {
            throw new Error("Mozilla returned an unexpected versions page.");
        }
        visited.add(next.href);
        const page = await get(next);
        if (first && page.status === 404) return {submit:true, initial:true};
        if (page.status !== 200) throw new Error(`Mozilla version lookup failed (HTTP ${page.status}). Check the API credentials and add-on ownership.`);
        if (!Array.isArray(page.body?.results)) throw new Error("Mozilla returned an invalid versions list.");
        const existing = page.body.results.find(item => item.version === version);
        if (existing) {
            if (!Number.isInteger(existing.id) || existing.id <= 0) throw new Error("Mozilla returned an invalid version ID.");
            const detail = await get(new URL(`${addonPath}versions/${existing.id}/`, amoRoot));
            if (detail.status !== 200) throw new Error(`Mozilla version detail lookup failed (HTTP ${detail.status}).`);
            const record = detail.body;
            if (record?.channel !== "listed" || !["public", "unreviewed"].includes(record?.file?.status)) {
                throw new Error(`Firefox extension version ${version} already exists but is not an active listed version. Check it on Mozilla Add-ons or increase the extension version.`);
            }
            if (!String(record.approval_notes || "").split(/\r?\n/).includes(markerPrefix + fingerprint)) {
                throw new Error(`Firefox extension version ${version} already exists with different or unverified source. Increase the extension version before publishing.`);
            }
            return {submit:false, initial:false};
        }
        first = false;
        next = page.body.next ? new URL(page.body.next, amoRoot) : null;
    }
    return {submit:true, initial:false};
}

async function privacyPolicy() {
    let policy;
    try { policy = await fs.readFile(privacyPolicyPath, "utf8"); }
    catch (error) {
        if (error.code === "ENOENT") throw new Error("Include Privacy Policy.txt in the release tag before submitting.", {cause:error});
        throw error;
    }
    if (!policy.trim()) throw new Error("Privacy Policy.txt is empty.");
    return policy;
}

export async function plan(outputDirectory, apiKey, apiSecret, request = fetch, commit = process.env.GITHUB_SHA) {
    const output = path.resolve(outputDirectory);
    const source = path.join(output, "extension");
    const manifest = JSON.parse(await fs.readFile(path.join(source, "manifest.json"), "utf8"));
    const id = manifest.browser_specific_settings?.gecko?.id;
    await privacyPolicy();
    const fingerprint = await sourceFingerprint(source);
    const decision = await submissionDecision({id, version:manifest.version, fingerprint, apiKey, apiSecret, request});
    if (decision.submit) {
        const listing = JSON.parse(await fs.readFile(path.join(extensionRoot, "firefox-amo-metadata.json"), "utf8"));
        const metadata = decision.initial ? listing : {version:listing.version};
        if (decision.initial) {
            if (!/^[0-9a-f]{40}$/i.test(commit || "")) throw new Error("A release commit SHA is required for the privacy policy link.");
            metadata.description["en-US"] += `\n\n[Privacy policy](https://github.com/Ryushe/window-warp/blob/${commit}/Privacy%20Policy.txt)`;
        }
        metadata.version.approval_notes += `\n\n${markerPrefix}${fingerprint}`;
        await fs.writeFile(path.join(output, "amo-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, {flag:"wx"});
    }
    return {...decision, id, version:manifest.version, fingerprint};
}

export async function ensurePrivacyPolicy({id, apiKey, apiSecret, policy, request = fetch}) {
    if (!id || !policy?.trim()) throw new Error("A Firefox extension ID and privacy policy are required.");
    const url = new URL(`addons/addon/${encodeURIComponent(id)}/eula_policy/`, amoRoot);
    const headers = {Accept:"application/json", Authorization:authorization(apiKey, apiSecret)};
    async function send(options) {
        try { return await request(url, {...options, redirect:"error", signal:AbortSignal.timeout(20000)}); }
        catch (error) { throw new Error(`Could not update the Mozilla privacy policy: ${error.message}. The submission may already exist; rerun the workflow.`, {cause:error}); }
    }
    const current = await send({headers});
    if (!current.ok) throw new Error(`Mozilla privacy policy lookup failed (HTTP ${current.status}). The submission may already exist; rerun the workflow.`);
    const body = await current.json();
    if (body?.privacy_policy && Object.values(body.privacy_policy).some(value => typeof value === "string" && value.trim())) return false;
    const updated = await send({
        method:"PATCH", headers:{...headers, "Content-Type":"application/json"},
        body:JSON.stringify({privacy_policy:{"en-US":policy}})
    });
    if (!updated.ok) throw new Error(`Mozilla privacy policy update failed (HTTP ${updated.status}). The submission may already exist; rerun the workflow.`);
    return true;
}

async function main() {
    const [, , command, directory] = process.argv;
    if (!directory || !["prepare", "plan", "policy"].includes(command)) throw new Error("Usage: node scripts/firefox-release.mjs <prepare|plan|policy> <output-directory>");
    if (command === "prepare") {
        console.log(`Prepared Firefox extension in ${await prepare(directory)}`);
        return;
    }
    if (command === "policy") {
        const manifest = JSON.parse(await fs.readFile(path.join(directory, "extension", "manifest.json"), "utf8"));
        const added = await ensurePrivacyPolicy({id:manifest.browser_specific_settings?.gecko?.id,
            apiKey:process.env.AMO_JWT_ISSUER, apiSecret:process.env.AMO_JWT_SECRET, policy:await privacyPolicy()});
        console.log(added ? "Added the existing privacy policy to the Firefox listing." : "The Firefox listing already has a privacy policy; leaving it unchanged.");
        return;
    }
    const result = await plan(directory, process.env.AMO_JWT_ISSUER, process.env.AMO_JWT_SECRET);
    if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `submit=${result.submit}\n`, "utf8");
    console.log(result.submit
        ? `Firefox ${result.version} is ready for ${result.initial ? "first listing" : "submission"}.`
        : `Firefox ${result.version} is already submitted with the same source; skipping.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(error.message || String(error)); process.exitCode = 1; });
}
