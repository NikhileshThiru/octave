import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { access, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const APP_URL = process.env.OCTAVE_CAPTURE_URL || "http://127.0.0.1:5173";
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MEDIA_DIR = join(ROOT, "media");
const WORK_DIR = join(
  process.env.TMPDIR || "/tmp",
  `octave-screenshots-${Date.now()}`
);
const WIDTH = 1920;
const HEIGHT = 1080;

const chromeCandidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "google-chrome",
  "chromium",
  "chromium-browser",
].filter(Boolean);

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  open() {
    return new Promise((resolvePromise, rejectPromise) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener("open", () => resolvePromise());
      this.ws.addEventListener("error", rejectPromise);
      this.ws.addEventListener("message", (event) => this.handleMessage(event));
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolvePromise, rejectPromise });
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
  }

  off(method, handler) {
    this.listeners.get(method)?.delete(handler);
  }

  handleMessage(event) {
    const message = JSON.parse(event.data);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.rejectPromise(new Error(message.error.message));
      else pending.resolvePromise(message.result || {});
      return;
    }

    const handlers = this.listeners.get(message.method);
    if (!handlers) return;
    for (const handler of handlers) handler(message.params || {});
  }
}

const chromePath = await findChrome();
const port = await getFreePort();

await mkdir(MEDIA_DIR, { recursive: true });
await mkdir(WORK_DIR, { recursive: true });

let chrome;
try {
  chrome = spawn(chromePath, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--user-data-dir=${join(WORK_DIR, "profile")}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    "about:blank",
  ], {
    stdio: ["ignore", "ignore", "pipe"],
  });

  chrome.stderr.setEncoding("utf8");
  chrome.stderr.on("data", (chunk) => {
    if (!chunk.includes("DevTools listening")) return;
    process.stderr.write(chunk);
  });

  await waitForChrome(port);
  const page = await openPage(port);

  await setViewport(page);

  await goto(page, `${APP_URL}/`);
  await waitForText(page, "Tap to start");
  await delay(1200);
  await screenshot(page, join(MEDIA_DIR, "octave-idle.png"));

  await page.send("Runtime.evaluate", {
    expression: "document.querySelector('button')?.click()",
    awaitPromise: true,
  });
  await waitForText(page, "Listening");
  await delay(1400);
  await screenshot(page, join(MEDIA_DIR, "octave-listening.png"));

  await goto(page, `${APP_URL}/?demo`);
  await waitForText(page, "Now Playing");
  await waitForText(page, "Afterglow");
  await delay(2200);
  await screenshot(page, join(MEDIA_DIR, "octave-now-playing.png"));

  console.log("Captured README screenshots in media/.");
} finally {
  if (chrome && !chrome.killed) chrome.kill("SIGTERM");
  await rm(WORK_DIR, { recursive: true, force: true });
}

async function openPage(debugPort) {
  const target = await httpJson({
    port: debugPort,
    method: "PUT",
    path: `/json/new?${encodeURIComponent("about:blank")}`,
  });
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    const text = exceptionDetails?.exception?.description || exceptionDetails?.text;
    if (text) console.error(`[browser exception] ${text}`);
  });
  cdp.on("Runtime.consoleAPICalled", ({ type, args = [] }) => {
    if (type !== "error") return;
    const text = args.map((arg) => arg.value || arg.description || "").join(" ");
    if (text) console.error(`[browser console.error] ${text}`);
  });
  return cdp;
}

async function setViewport(page) {
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function goto(page, url) {
  const loaded = waitForEvent(page, "Page.loadEventFired", 10_000);
  await page.send("Page.navigate", { url });
  await loaded;
  await delay(300);
}

async function waitForText(page, text, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  const needle = text.toLowerCase();
  while (Date.now() < deadline) {
    const result = await page.send("Runtime.evaluate", {
      expression: `(document.body?.innerText || '').toLowerCase().includes(${JSON.stringify(needle)})`,
      returnByValue: true,
    });
    if (result.result.value) return;
    await delay(100);
  }
  const debug = await page.send("Runtime.evaluate", {
    expression: "`${location.href}\\n${document.body?.innerText || ''}`",
    returnByValue: true,
  });
  console.error(debug.result.value);
  throw new Error(`Timed out waiting for text: ${text}`);
}

async function screenshot(page, path) {
  const result = await page.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  await writeFile(path, Buffer.from(result.data, "base64"));
}

async function waitForChrome(debugPort, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await httpJson({ port: debugPort, path: "/json/version" });
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error("Timed out waiting for Chrome DevTools.");
}

function httpJson({ port: debugPort, method = "GET", path }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request({
      hostname: "127.0.0.1",
      port: debugPort,
      method,
      path,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          rejectPromise(new Error(`HTTP ${res.statusCode}: ${body}`));
          return;
        }
        try {
          resolvePromise(JSON.parse(body));
        } catch (error) {
          rejectPromise(error);
        }
      });
    });
    req.on("error", rejectPromise);
    req.end();
  });
}

function getFreePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePromise(address.port));
    });
    server.on("error", rejectPromise);
  });
}

async function findChrome() {
  for (const candidate of chromeCandidates) {
    if (!candidate.includes("/")) return candidate;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known browser location.
    }
  }
  throw new Error("Could not find Chrome or Chromium. Set CHROME_PATH to the browser binary.");
}

function waitForEvent(cdp, method, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      cdp.off(method, handler);
      rejectPromise(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
    const handler = (params) => {
      clearTimeout(timeout);
      cdp.off(method, handler);
      resolvePromise(params);
    };
    cdp.on(method, handler);
  });
}
