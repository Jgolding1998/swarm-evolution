"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {spawn} = require("node:child_process");
const {chromium} = require(process.env.SWARM_PLAYWRIGHT || "playwright");

const root = path.resolve(__dirname, "..");
const captures = process.env.SWARM_CAPTURE_DIR || path.join(root, "work", "browser");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let checks = 0;
const check = (value, message) => {assert.ok(value, message); checks += 1;};

async function touchReach(page, cdp, selector) {
  const reachable = () => page.locator(selector).evaluate((button) => {
    const b = button.getBoundingClientRect(), s = document.querySelector(".stage").getBoundingClientRect();
    return b.top >= s.top && b.bottom <= s.bottom && document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) === button;
  });
  for (let swipe = 0; swipe < 5 && !await reachable(); swipe += 1) {
    const area = await page.locator(".stage").boundingBox();
    const x = area.x + area.width / 2;
    await cdp.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x, y: area.y + area.height * 0.85}]});
    for (let i = 1; i <= 6; i += 1) {
      await cdp.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{x, y: area.y + area.height * (0.85 - i * 0.1)}]});
      await delay(30);
    }
    await cdp.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
    await delay(100);
  }
  return reachable();
}

async function main() {
  const server = spawn(process.env.SWARM_PYTHON || "python", ["-u", "-c", "import server; s=server.make_server(0); print(s.server_port,flush=True); s.serve_forever()"], {cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
  let output = "", errors = "", browser;
  server.stdout.on("data", (chunk) => {output += chunk;});
  server.stderr.on("data", (chunk) => {errors += chunk;});
  const failures = [], external = [], consoleErrors = [];
  try {
    for (let i = 0; i < 100 && !/^\d+\s/.test(output); i += 1) await delay(50);
    check(/^\d+\s/.test(output), "Owned loopback server started");
    const origin = "http://127.0.0.1:" + Number(output.trim());
    browser = await chromium.launch({headless: true, args: ["--mute-audio"], ...(process.env.SWARM_CHROME ? {executablePath: process.env.SWARM_CHROME} : {})});
    fs.mkdirSync(captures, {recursive: true});

    async function context(options = {}) {
      const value = await browser.newContext({reducedMotion: "reduce", ...options});
      await value.route("**/*", async (route) => {
        if (!route.request().url().startsWith(origin + "/")) {
          external.push("unexpected origin");
          await route.abort();
        } else await route.continue();
      });
      await value.addInitScript(() => {
        globalThis.AudioContext = class {constructor() {throw Error("Audio disabled in tests");}};
        globalThis.webkitAudioContext = globalThis.AudioContext;
      });
      value.on("page", (page) => {
        page.on("pageerror", () => failures.push("page error"));
        page.on("console", (message) => {if (message.type() === "error") consoleErrors.push("console error");});
      });
      return value;
    }

    const desktop = await context({viewport: {width: 1440, height: 1000}});
    const page = await desktop.newPage();
    const response = await page.goto(origin + "/?seed=review-seed");
    check(response.status() === 200, "Game responds");
    check(response.headers()["content-security-policy"].includes("connect-src 'none'"), "Remote connections are blocked");
    check(await page.evaluate(() => globalThis.__swarmDebug === undefined), "No production test state hook");
    check(await page.locator("#btn-sound").getAttribute("aria-pressed") === "false", "Sound starts off");
    await page.locator("#btn-start").click();
    const seededTraits = await page.locator("#gene-list").textContent();
    await page.keyboard.down("ArrowRight"); await delay(100); await page.keyboard.up("ArrowRight");
    await page.keyboard.down("Space"); await delay(4500); await page.keyboard.up("Space");
    check(Number((await page.locator("#hud-score").textContent()).replaceAll(",", "")) > 0, "Keyboard play earns score through the real simulation");
    await page.screenshot({path: path.join(captures, "desktop.png"), fullPage: true});
    await page.keyboard.press("p");
    check(await page.locator("#panel-pause").isVisible(), "Keyboard pause opens the panel");
    check(await page.locator("#btn-resume").evaluate((node) => node === document.activeElement), "Pause moves focus to Resume");
    const pausedHud = await page.locator(".hud").textContent();
    await delay(200);
    check(await page.locator(".hud").textContent() === pausedHud, "Paused HUD does not advance");
    await page.keyboard.press("Enter");
    check(await page.locator("#overlay").isHidden(), "Enter resumes from the focused button");
    await page.evaluate(() => {Object.defineProperty(document, "hidden", {configurable: true, get: () => true}); document.dispatchEvent(new Event("visibilitychange"));});
    check(await page.locator("#panel-pause").isVisible(), "Visibility handler pauses play");
    check((await page.locator("#pause-reason").textContent()).includes("hidden"), "Hidden-tab pause explains the reason");
    await page.evaluate(() => {delete document.hidden; document.dispatchEvent(new Event("visibilitychange"));});
    check(await page.locator("#panel-pause").isVisible(), "Visibility restoration waits for user resume");
    await page.locator("#btn-resume").click(); await page.keyboard.press("r");
    await page.waitForFunction(() => document.querySelector("#hud-score").textContent === "0");
    check(await page.locator("#hud-lives").getAttribute("aria-label") === "3 lives", "Restart restores lives");
    check(await page.locator("#gene-list").textContent() === seededTraits, "Restart preserves the explicit URL seed");
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Desktop has no horizontal overflow");
    await desktop.close();

    for (const [width, height] of [[390, 844], [844, 390], [320, 568]]) {
      const mobile = await context({viewport: {width, height}, isMobile: true, hasTouch: true, deviceScaleFactor: 2});
      const phone = await mobile.newPage();
      await phone.goto(origin + "/?seed=phone-seed");
      const cdp = await mobile.newCDPSession(phone);
      check(await touchReach(phone, cdp, "#btn-start"), `Launch is reachable at ${width}x${height}`);
      await phone.screenshot({path: path.join(captures, `title-${width}x${height}.png`), fullPage: true});
      await phone.locator("#btn-start").tap();
      check(await phone.locator("#overlay").isHidden(), `Touch Launch starts play at ${width}x${height}`);
      const field = await phone.locator("#game").boundingBox();
      await cdp.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x: field.x + field.width * 0.25, y: field.y + field.height * 0.8}]});
      for (let i = 1; i <= 6; i += 1) {
        await cdp.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{x: field.x + field.width * (0.25 + i * 0.07), y: field.y + field.height * 0.8}]});
        await delay(70);
      }
      await cdp.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
      await phone.locator("#btn-pause").tap();
      await phone.locator("#btn-resume").tap();
      check(await phone.locator("#overlay").isHidden(), `Touch pause and resume work at ${width}x${height}`);
      await phone.locator("#btn-intel").tap();
      check(await phone.locator("#btn-intel").getAttribute("aria-expanded") === "true", "Phone intel opens");
      check(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No horizontal overflow at ${width}x${height}`);
      await phone.screenshot({path: path.join(captures, `play-${width}x${height}.png`), fullPage: true});
      await mobile.close();
    }

    const fast = await context({viewport: {width: 320, height: 568}, isMobile: true, hasTouch: true});
    await fast.addInitScript(() => {let clock = 0; window.requestAnimationFrame = (callback) => setTimeout(() => callback(clock += 100), 4);});
    const end = await fast.newPage();
    await end.goto(origin + "/?seed=game-over");
    const endTouch = await fast.newCDPSession(end);
    check(await touchReach(end, endTouch, "#btn-start"), "Short-screen game-over fixture can launch by touch");
    await end.locator("#btn-start").tap();
    await end.locator("#panel-over").waitFor({state: "visible", timeout: 15000});
    check((await end.locator("#over-summary").textContent()).includes("Score"), "Actual simulation reaches game over");
    const saved = await end.evaluate(() => JSON.parse(localStorage.getItem("swarm-evolution.best.v1")));
    check(Object.keys(saved).sort().join(",") === "best,v,wave" && saved.wave >= 1, "Game over saves only the bounded score schema");
    check(await touchReach(end, endTouch, "#btn-again"), "Fly again remains reachable on a short screen");
    await end.screenshot({path: path.join(captures, "game-over-320x568.png"), fullPage: true});
    await end.locator("#btn-again").tap();
    check(await end.locator("#panel-over").isHidden(), "Fly again restarts play");
    await end.evaluate(() => localStorage.setItem("swarm-evolution.best.v1", "{broken"));
    await end.reload();
    check(await end.locator("#hud-best").textContent() === "0", "Malformed stored data is ignored");
    await fast.close();

    const hostile = await context({viewport: {width: 1280, height: 900}});
    await hostile.addInitScript(() => {Object.defineProperty(window, "localStorage", {get() {throw Error("Storage disabled");}});});
    const denied = await hostile.newPage();
    await denied.goto(origin + "/?seed=" + encodeURIComponent("<img src=x onerror=window.injected=true>"));
    await denied.locator("#btn-start").click(); await denied.keyboard.press("p");
    check(await denied.locator("#panel-pause").isVisible(), "Denied storage leaves play usable");
    check(await denied.evaluate(() => window.injected === undefined), "Seed text cannot execute markup");
    check(await denied.locator("img").count() === 0, "Seed text creates no image elements");
    await hostile.close();
    check(external.length === 0, "No external requests");
    check(failures.length === 0, "No page exceptions");
    check(consoleErrors.length === 0, "No browser console errors");
    check(errors === "", "No server errors or request logs");
    console.log(JSON.stringify({checks, externalRequests: external.length, pageErrors: failures.length, consoleErrors: consoleErrors.length}));
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

main().catch((error) => {console.error(error); process.exitCode = 1;});
