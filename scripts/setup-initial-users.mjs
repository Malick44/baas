#!/usr/bin/env node
// Prepares temporary credentials locally; never contacts a server or prints passwords.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const KEYS = ["BAAS_INITIAL_USERS_ENABLED", "BAAS_INITIAL_ORGANIZATION_NAME", "BAAS_INITIAL_ORGANIZATION_SLUG", "BAAS_INITIAL_OWNER_EMAIL", "BAAS_INITIAL_OWNER_PASSWORD", "BAAS_INITIAL_ADMIN_EMAIL", "BAAS_INITIAL_ADMIN_PASSWORD"];

async function prepare(path, name, slug, owner, admin) {
  let original = Buffer.alloc(0);
  let stat;
  try {
    stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("env file must be a regular file, without symlinks or hard links");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { original = await file.readFile(); } finally { await file.close(); }
  } catch (e) { if (e.code !== "ENOENT") throw e; }
  const found = new Map();
  for (const line of original.toString("utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match || !KEYS.includes(match[1])) continue;
    if (found.has(match[1])) throw new Error("duplicate initial-user configuration; resolve it before running setup");
    found.set(match[1], match[2].trim());
  }
  if (found.size) {
    if (found.size !== KEYS.length || found.get(KEYS[0]) !== "true" || found.get(KEYS[3]) !== owner || found.get(KEYS[5]) !== admin || found.get(KEYS[2]) !== slug || found.get(KEYS[1]) !== JSON.stringify(name) || !found.get(KEYS[4]) || !found.get(KEYS[6]))
      throw new Error("initial-user configuration already exists; setup will not overwrite or rotate it");
    console.log("Initial-user credentials already exist; no values changed.");
    return;
  }
  const vals = ["true", JSON.stringify(name), slug, owner, randomBytes(32).toString("base64url"), admin, randomBytes(32).toString("base64url")];
  const block = Buffer.from(`${original.length && original.at(-1) !== 10 ? "\n" : ""}\n# One-time owner/admin setup. Replace each temporary password at first sign-in.\n${KEYS.map((key, i) => `${key}=${vals[i]}`).join("\n")}\n`);
  const temp = join(dirname(path), `.baas-initial-users-${randomBytes(8).toString("hex")}.tmp`);
  try {
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(Buffer.concat([original, block])); await file.sync(); } finally { await file.close(); }
    if (stat) {
      const current = await lstat(path);
      if (!current.isFile() || current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev || current.nlink !== 1 || !(await readFile(path)).equals(original))
        throw new Error("env file changed during setup; no changes applied");
    } else {
      try { await lstat(path); throw new Error("env file appeared during setup; no changes applied"); } catch (e) { if (e.code !== "ENOENT") throw e; }
    }
    await rename(temp, path);
    console.log(`Prepared temporary owner/admin credentials in ${path} (mode 0600; passwords not displayed).`);
  } finally { await unlink(temp).catch(() => {}); }
}

async function main() {
  const { values } = parseArgs({ options: {
    "output-env": { type: "string", default: ".env.local" },
    "organization-name": { type: "string" }, "organization-slug": { type: "string" },
    "owner-email": { type: "string" }, "admin-email": { type: "string" },
  } });
  const name = values["organization-name"]?.trim();
  const slug = values["organization-slug"];
  const owner = values["owner-email"]?.trim().toLowerCase();
  const admin = values["admin-email"]?.trim().toLowerCase();
  // Restrict bootstrap email syntax to avoid env-file quoting/interpolation ambiguity.
  const email = /^[a-z0-9._+%-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,63}$/;
  if (!name || name.length > 80 || /[\r\n\x00$\\"]/.test(name)) throw new Error("--organization-name is required (1-80 characters, without line breaks, double quotes, backslashes or $)");
  if (!slug || !/^[a-z0-9-]{2,40}$/.test(slug)) throw new Error("--organization-slug is required (2-40 chars of a-z, 0-9, -)");
  if (!owner || !admin || !email.test(owner) || !email.test(admin) || owner === admin) throw new Error("--owner-email and --admin-email must be valid, distinct addresses");
  const path = resolve(values["output-env"]);
  const lockPath = `${path}.initial-users.lock`;
  const lock = await open(lockPath, "wx", 0o600).catch((e) => {
    if (e.code === "EEXIST") throw new Error("setup is locked; finish the other setup before retrying");
    throw e;
  });
  try { await prepare(path, name, slug, owner, admin); } finally { await lock.close(); await unlink(lockPath); }
}

main().catch((e) => { console.error(`Initial-user setup failed: ${e.message}`); process.exitCode = 1; });
