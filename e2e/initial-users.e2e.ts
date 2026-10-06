import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser } from "playwright-core";
import { makePlatform } from "../src/platform-testkit.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;
const CHROME = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

describe("initial users in the dashboard", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let browser: Browser;
  let base: string;
  const problems: string[] = [];
  const cfg = {
    organization: { name: "Initial team", slug: "initial-team" },
    owner: { email: "owner@example.com", password: "temporary-owner-password-123" },
    admin: { email: "admin@example.com", password: "temporary-admin-password-456" },
  };
  before(async () => {
    t = await makePlatform(ADMIN!, { initialMembers: cfg });
    const ports = await t.platform.listen({ api: 0, gateway: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${ports.api}`;
    browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  });
  after(async () => { await browser?.close(); await t?.close(); assert.deepEqual(problems, []); });

  for (const role of ["owner", "admin"] as const) it(`forces ${role} password replacement on sign-in, reload and deep links`, async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => problems.push(e.message));
    await page.goto(`${base}/#/team`);
    await page.fill("#login-email", cfg[role].email);
    await page.fill("#login-password", cfg[role].password);
    await page.click("#remember-member");
    await page.click("#signin-member");
    await page.waitForSelector("#required-password-form");
    assert.equal(await page.locator("#project-grid, .appbar").count(), 0);
    await page.reload();
    await page.waitForSelector("#required-password-form");
    await page.goto(`${base}/#/p/${"0".repeat(20)}/overview`);
    await page.waitForSelector("#required-password-form");
    await page.keyboard.press("Control+k");
    assert.equal(await page.locator("dialog.palette").count(), 0);
    const shots = join(import.meta.dirname, "screenshots");
    await mkdir(shots, { recursive: true });
    await page.screenshot({ path: join(shots, `initial-${role}-password-required.png`), fullPage: true });

    // Sign out is available even while the normal dashboard is restricted.
    await page.click("#required-password-signout");
    await page.waitForSelector("#member-form");
    await page.fill("#login-email", cfg[role].email);
    await page.fill("#login-password", cfg[role].password);
    await page.click("#signin-member");
    await page.waitForSelector("#required-password-form");
    await page.fill("#required-current", cfg[role].password);
    await page.fill("#required-new", cfg[role].password);
    await page.fill("#required-confirm", cfg[role].password);
    await page.click("#required-password-submit");
    await page.locator("#required-password-error:not([hidden])").waitFor();
    assert.match((await page.textContent("#required-password-error"))!, /different password/);
    const next = `my-${role}-chosen-password-123`;
    await page.fill("#required-new", next);
    await page.fill("#required-confirm", "different-password");
    await page.click("#required-password-submit");
    assert.match((await page.textContent("#required-password-error"))!, /do not match/);
    await page.fill("#required-confirm", next);
    await page.fill("#required-current", "wrong-password");
    await page.click("#required-password-submit");
    await page.locator("#required-password-error:not([hidden])").waitFor();
    assert.match((await page.textContent("#required-password-error"))!, /current password is incorrect/);
    await page.fill("#required-current", cfg[role].password);
    await page.click("#required-password-submit");
    await page.waitForSelector("#project-grid");
    await page.reload();
    await page.waitForSelector("#project-grid");
    assert.equal(await page.locator("#required-password-form").count(), 0);
    await page.click("#avatar");
    await page.click("#signout");
    await page.fill("#login-email", cfg[role].email);
    await page.fill("#login-password", cfg[role].password);
    await page.click("#signin-member");
    await page.locator("#member-error:not([hidden])").waitFor();
    await page.fill("#login-password", next);
    await page.click("#signin-member");
    await page.waitForSelector("#project-grid");
    await context.close();
  });
});
