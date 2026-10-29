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

    async function context(options = {}, fakeAudio = false) {
      const value = await browser.newContext({reducedMotion: "reduce", ...options});
      await value.route("**/*", async (route) => {
        if (!route.request().url().startsWith(origin + "/")) {
          external.push("unexpected origin");
          await route.abort();
        } else await route.continue();
      });
      await value.addInitScript((fakeAudio) => {
        if (fakeAudio === 'real') {
          const Native = globalThis.AudioContext;
          globalThis.__audioStarts = 0;
          globalThis.AudioContext = class extends Native {
            constructor(...args) {super(...args); globalThis.__realAudio = this;}
            createOscillator() {const node = super.createOscillator(), start = node.start.bind(node); node.start = (...args) => {globalThis.__audioStarts++; return start(...args);}; return node;}
          };
          return;
        }
        const node = () => ({gain: {value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}},
          frequency: {setValueAtTime() {}, exponentialRampToValueAtTime() {}},
          connect() {return this;}, start() {globalThis.__audioStarts += 1;}, stop() {}});
        globalThis.__audioStarts = 0;
        globalThis.AudioContext = fakeAudio ? class {
          constructor() {this.state = "suspended"; this.sampleRate = 8000; this.currentTime = 1; this.destination = {}; globalThis.__fakeAudio = this;}
          resume() {this.state = "running"; return Promise.resolve();}
          suspend() {this.state = "suspended"; return Promise.resolve();}
          close() {this.state = "closed"; return Promise.resolve();}
          createGain() {return node();}
          createOscillator() {return node();}
          createBiquadFilter() {return node();}
          createBufferSource() {return node();}
          createBuffer(channels, length) {return {getChannelData: () => new Float32Array(length)};}
        } : class {constructor() {throw Error("Audio disabled in tests");}};
        globalThis.webkitAudioContext = globalThis.AudioContext;
      }, fakeAudio);
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
    await page.locator('#btn-sound').click();
    check(await page.locator('#btn-sound').textContent() === 'Sound unavailable', 'Denied audio has honest retry feedback');
    check(await page.locator('#sound-status').textContent().then(t => t.includes('game still works')), 'Audio failure explains that play remains available');
    check(await page.locator('#run-mode').inputValue() === 'campaign', 'UI defaults to a twelve-wave campaign');
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
    await page.keyboard.down('Space'); await page.keyboard.press('p');
    await page.keyboard.down('Space'); await page.keyboard.up('Space');
    check(await page.locator('#panel-pause').isVisible(), 'Releasing held fire after focus moves to Resume cannot dismiss pause');
    await page.keyboard.press('Space');
    check(await page.locator('#overlay').isHidden(), 'A fresh Space press still activates Resume');
    await page.evaluate(() => window.dispatchEvent(new FocusEvent('blur')));
    check(await page.evaluate(() => !document.hidden), 'Focus-loss fixture keeps the document visible');
    check(await page.locator('#panel-pause').isVisible(), 'Visible window focus loss pauses play');
    check((await page.locator('#pause-reason').textContent()).includes('focus'), 'Focus pause explains its cause');
    const focusHud = await page.locator('.hud').textContent();
    await page.waitForTimeout(200);
    check(await page.locator('.hud').textContent() === focusHud, 'Focus-paused simulation does not advance');
    await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')));
    check(await page.locator('#panel-pause').isVisible(), 'Focus restoration waits for manual resume');
    await page.locator('#btn-resume').click();
    await page.evaluate(() => {Object.defineProperty(document, "hidden", {configurable: true, get: () => true}); document.dispatchEvent(new Event("visibilitychange"));});
    check(await page.locator("#panel-pause").isVisible(), "Visibility handler pauses play");
    check((await page.locator("#pause-reason").textContent()).includes("hidden"), "Hidden-tab pause explains the reason");
    await page.evaluate(() => {delete document.hidden; document.dispatchEvent(new Event("visibilitychange"));});
    check(await page.locator("#panel-pause").isVisible(), "Visibility restoration waits for user resume");
    await page.locator("#btn-resume").click(); await page.keyboard.press("r");
    await page.waitForFunction(() => document.querySelector("#hud-score").textContent === "0");
    check(await page.locator("#hud-lives").getAttribute("aria-label") === "3 lives", "Restart restores lives");
    check(await page.locator("#gene-list").textContent() === seededTraits, "Restart preserves the explicit URL seed");
    await page.locator('#run-mode').selectOption('endless');
    check((await page.locator('#run-mode-status').textContent()).includes('Restart to apply'), 'A mode choice waits for a new run');
    check((await page.locator('#hud-best-label').textContent()).includes('Campaign'), 'Changing the selector preserves the current run');
    await page.locator('#btn-restart').click();
    check((await page.locator('#hud-best-label').textContent()).includes('Endless'), 'Restart applies the selected mode');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Desktop has no horizontal overflow");
    await page.setViewportSize({width: 1366, height: 768});
    await page.evaluate(() => {scrollTo(0, document.documentElement.scrollHeight); dispatchEvent(new Event('resize')); scrollTo(0, 0);});
    check(await page.locator('#game').evaluate(node => node.getBoundingClientRect().bottom <= innerHeight), 'Scroll and resize preserve the whole playfield after returning to the top');
    await desktop.close();

    for (const launch of ["click", "Enter", "Space", "tap"]) {
      const sound = await context({viewport: {width: 1280, height: 900}, hasTouch: true}, true);
      const audioPage = await sound.newPage();
      await audioPage.goto(origin + "/?seed=audio-title");
      await audioPage.locator("#btn-sound").click();
      check(await audioPage.evaluate(() => globalThis.__fakeAudio.state === "running"), "Title sound opt-in resumes the fake context");
      await audioPage.evaluate(() => {Object.defineProperty(document, "hidden", {configurable: true, get: () => true}); document.dispatchEvent(new Event("visibilitychange"));});
      check(await audioPage.evaluate(() => globalThis.__fakeAudio.state === "suspended"), "Hidden title suspends opted-in audio");
      await audioPage.evaluate(() => {delete document.hidden; document.dispatchEvent(new Event("visibilitychange"));});
      await audioPage.evaluate(() => {globalThis.__audioStarts = 0;});
      const button = audioPage.locator("#btn-start");
      if (launch === "click") await button.click();
      else if (launch === "tap") await button.tap();
      else {await button.focus(); await audioPage.keyboard.press(launch);}
      check(await audioPage.evaluate(() => globalThis.__fakeAudio.state === "running"), `Launch by ${launch} resumes opted-in title audio after a hidden tab`);
      await audioPage.waitForFunction(() => globalThis.__audioStarts > 0);
      check(await audioPage.locator("#btn-sound").getAttribute("aria-pressed") === "true", "Sound opt-in stays enabled after launch");
      await sound.close();
    }

    const actual = await context({viewport: {width: 1280, height: 900}}, 'real');
    const real = await actual.newPage();
    await real.goto(origin + '/?seed=actual-audio');
    check(await real.evaluate(() => !globalThis.__realAudio), 'No real audio context is created before opt-in');
    await real.locator('#btn-sound').click();
    await real.waitForFunction(() => document.querySelector('#btn-sound').getAttribute('aria-pressed') === 'true');
    check(await real.evaluate(() => __realAudio.state === 'running' && __audioStarts === 1), 'Actual Chrome resumes audio and schedules the confirmation cue');
    check((await real.locator('#sound-status').textContent()).includes('test tone'), 'The confirmation explains external volume limits');
    const rendered = await real.evaluate(async () => {
      const {scheduleTone} = await import('/src/audio.js');
      const ctx = new OfflineAudioContext(1, 24000, 48000), master = ctx.createGain();
      master.gain.value = 0.4; master.connect(ctx.destination);
      scheduleTone(ctx, master, 'triangle', 660, 880, 0.15, 0.18);
      const data = (await ctx.startRendering()).getChannelData(0);
      let sum = 0, peak = 0, tail = 0;
      for (let i = 0; i < data.length; i++) {sum += data[i] ** 2; peak = Math.max(peak, Math.abs(data[i])); if (i > 12000) tail = Math.max(tail, Math.abs(data[i]));}
      return {rms: Math.sqrt(sum / data.length), peak, tail};
    });
    check(rendered.rms > 0.001 && rendered.peak < 1 && rendered.tail === 0, 'Production tone graph renders a nonzero bounded waveform and stops');
    console.log(JSON.stringify({offlineAudio: rendered, physicalAudibilityTested: false}));
    await real.locator('#btn-sound').click();
    await real.waitForFunction(() => __realAudio.state === 'suspended');
    check(await real.locator('#btn-sound').getAttribute('aria-pressed') === 'false', 'Real Sound off suspends the context');
    await actual.close();

    for (const [mode, waves] of [['campaign', 12], ['extended', 24]]) {
      const victory = await context({viewport: {width: 1280, height: 900}});
      // Only this test response starts at a final clear. The shipped module has no debug hook.
      await victory.route('**/src/sim.js', async route => {
        const response = await route.fetch();
        const source = (await response.text()).replace('spawnWave(state);\n  return state;', `spawnWave(state);\n  state.wave = ${waves}; state.enemies.length = state.shots.length = 0;\n  return state;`);
        await route.fulfill({response, body: source});
      });
      const won = await victory.newPage(); await won.goto(origin + '/?seed=terminal-ui&run=' + mode);
      await won.locator('#btn-start').click(); await won.locator('#panel-over').waitFor({state: 'visible'});
      check(await won.locator('#over-title').textContent() === 'Campaign complete', `${waves}-wave victory has its own result heading`);
      check((await won.locator('#over-summary').textContent()).includes(`All ${waves} waves held`), 'Victory describes the selected target');
      check(await won.evaluate(key => JSON.parse(localStorage.getItem(key)).wave, `swarm-evolution.best.v2.${mode}.evolving`) === waves, 'Victory saves in the matching mode key');
      await victory.close();
    }

    for (const [width, height] of [[390, 844], [375, 667], [844, 390], [320, 568]]) {
      const mobile = await context({viewport: {width, height}, isMobile: true, hasTouch: true, deviceScaleFactor: 2});
      const phone = await mobile.newPage();
      await phone.goto(origin + "/?seed=phone-seed");
      await phone.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--field-space') !== '');
      check(await phone.locator('#game').evaluate(node => {const r = node.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight;}), `Entire playfield stays on screen at ${width}x${height}`);
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
    const saved = await end.evaluate(() => JSON.parse(localStorage.getItem("swarm-evolution.best.v2.campaign.evolving")));
    check(Object.keys(saved).sort().join(",") === "best,v,wave" && saved.wave >= 1, "Game over saves only the bounded score schema");
    check(await touchReach(end, endTouch, "#btn-again"), "Fly again remains reachable on a short screen");
    await end.screenshot({path: path.join(captures, "game-over-320x568.png"), fullPage: true});
    await end.locator("#btn-again").tap();
    check(await end.locator("#panel-over").isHidden(), "Fly again restarts play");
    await end.evaluate(() => localStorage.setItem("swarm-evolution.best.v2.campaign.evolving", "{broken"));
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
