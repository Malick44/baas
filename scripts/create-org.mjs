#!/usr/bin/env node
// Creates an organisation against a running baas server via POST /v1/organizations.
import { parseArgs } from "node:util";

const EMAIL = /^[a-z0-9._+%-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,63}$/;

async function main() {
    const { values } = parseArgs({
        options: {
            "url": { type: "string", default: process.env.BAAS_URL ?? "http://localhost:8080" },
            "bootstrap-token": { type: "string" },
            "name": { type: "string" }, "slug": { type: "string" },
            "owner-email": { type: "string" }, "owner-password": { type: "string" }, "owner-name": { type: "string" },
        }
    });

    const token = values["bootstrap-token"] ?? process.env.BAAS_BOOTSTRAP_TOKEN;
    if (!token) throw new Error("set BAAS_BOOTSTRAP_TOKEN (or pass --bootstrap-token)");

    const name = values.name?.trim();
    const slug = values.slug;
    if (!name || name.length > 80 || /[\r\n\x00$\\"]/.test(name)) throw new Error("--name is required (1-80 characters, without line breaks, double quotes, backslashes or $)");
    if (!slug || !/^[a-z0-9-]{2,40}$/.test(slug)) throw new Error("--slug is required (2-40 chars of a-z, 0-9, -)");

    const ownerEmail = values["owner-email"]?.trim().toLowerCase();
    const ownerPassword = values["owner-password"];
    if (ownerEmail && !EMAIL.test(ownerEmail)) throw new Error("--owner-email must be a valid address");
    if (ownerEmail && !ownerPassword) throw new Error("--owner-password is required when --owner-email is set");

    const body = { name, slug, ...(ownerEmail ? { owner_email: ownerEmail, owner_password: ownerPassword, ...(values["owner-name"] ? { owner_name: values["owner-name"] } : {}) } : {}) };

    const res = await fetch(new URL("/v1/organizations", values.url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-bootstrap-token": token },
        body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`create failed (${res.status}): ${json.error ?? JSON.stringify(json)}`);

    console.log(`Created organisation "${json.organization.name}" (${json.organization.slug}, id ${json.organization.id}).`);
    if (json.owner_token) console.log(`Owner API token: ${json.owner_token}`);
    if (json.owner) console.log(`Owner account: ${json.owner.email}`);
}

main().catch((e) => { console.error(`Create organisation failed: ${e.message}`); process.exitCode = 1; });
