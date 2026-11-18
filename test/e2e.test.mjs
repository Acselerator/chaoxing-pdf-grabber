// 端到端测试：真浏览器 + 真学习通页面 + 真 CDN。
// 需要登录态，所以默认跳过；本地这样跑：
//   CXPG_E2E=1 \
//   CXPG_COURSE_URL='https://mooc1.chaoxing.com/mycourse/studentstudy?...' \
//   node --test test/e2e.test.mjs
//
// 注意：课程地址里带你的 courseId/clazzid/enc，不要写进仓库。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, USER_SCRIPT } from "./harness.mjs";
import { parseStoredZip } from "./zip.mjs";

const ENABLED = process.env.CXPG_E2E === "1";
const REASON =
  "端到端测试需要真实浏览器与学习通登录态：设置 CXPG_E2E=1 与 CXPG_COURSE_URL 后再跑";

const DISPLAY = process.env.CXPG_DISPLAY || ":99";
const CDP_PORT = Number(process.env.CXPG_CDP_PORT || 9245);
const TIMEOUT_ZIP_MS = Number(process.env.CXPG_E2E_TIMEOUT_MS || 240000);
const PROFILE_SRC = process.env.CXPG_PROFILE_SRC || path.join(os.homedir(), ".config", "vivaldi");
const BROWSER = process.env.CXPG_BROWSER || "vivaldi";
const COURSE_URL = process.env.CXPG_COURSE_URL || "";
const DOWNLOAD_DIR = process.env.CXPG_DOWNLOAD_DIR || path.join(os.tmpdir(), "cxpg-e2e-downloads");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------- CDP 最小客户端 ------------------------- */

class CDP {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.exceptions = [];
  }

  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error(`CDP 连接失败：${this.url}`)), { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else resolve(message.result);
        return;
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        this.consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
      }
      if (message.method === "Runtime.exceptionThrown") {
        this.exceptions.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text || "");
      }
    });
    return this;
  }

  send(method, params = {}, sessionId = this.sessionId, timeoutMs = 60000) {
    this.id += 1;
    const id = this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, timeoutMs).unref?.();
    });
  }

  async eval(expression, { awaitPromise = false } = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`页面求值异常：${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  close() {
    try {
      this.ws?.close();
    } catch (_) {
      /* ignore */
    }
  }
}

async function httpJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} → ${response.status}`);
  return response.json();
}

/* ------------------------- 环境准备 ------------------------- */

function pickBrowserBinary() {
  const candidates = [BROWSER, "vivaldi", "vivaldi-stable", "google-chrome", "chromium", "chromium-browser"];
  for (const candidate of candidates) {
    for (const dir of (process.env.PATH || "").split(":")) {
      const full = path.join(dir, candidate);
      if (existsSync(full)) return full;
    }
  }
  throw new Error(`找不到浏览器可执行文件（试过 ${candidates.join(", ")}），可用 CXPG_BROWSER 指定`);
}

async function ensureDisplay() {
  const socket = `/tmp/.X11-unix/X${DISPLAY.replace(":", "")}`;
  if (existsSync(socket)) return null;
  const child = spawn("Xvfb", [DISPLAY, "-screen", "0", "1920x1080x24", "-nolisten", "tcp"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  for (let index = 0; index < 50; index += 1) {
    if (existsSync(socket)) return child;
    await sleep(200);
  }
  throw new Error(`Xvfb ${DISPLAY} 起不来`);
}

function prepareProfile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cxpg-e2e-profile-"));
  const localState = path.join(PROFILE_SRC, "Local State");
  assert.ok(existsSync(localState), `找不到 ${localState}（用 CXPG_PROFILE_SRC 指到你的浏览器配置目录）`);
  cpSync(localState, path.join(dir, "Local State"));
  const defaultDir = path.join(PROFILE_SRC, "Default");
  mkdirSync(path.join(dir, "Default"), { recursive: true });
  for (const name of ["Preferences", "Cookies", "Cookies-journal"]) {
    const from = path.join(defaultDir, name);
    if (existsSync(from)) cpSync(from, path.join(dir, "Default", name));
  }
  // 新版 Chromium 系把 Cookie 放在 Default/Network/Cookies
  const networkDir = path.join(defaultDir, "Network");
  if (existsSync(networkDir)) cpSync(networkDir, path.join(dir, "Default", "Network"), { recursive: true });
  return dir;
}

function buildPrelude() {
  // 用 localStorage 兜 GM_setValue/getValue，GM_xmlhttpRequest 用 fetch 实现。
  return `
    (() => {
      const store = {
        get(k) { const raw = localStorage.getItem('cxpg-gm:' + k); return raw === null ? undefined : JSON.parse(raw); },
        set(k, v) { localStorage.setItem('cxpg-gm:' + k, JSON.stringify(v)); },
        del(k) { localStorage.removeItem('cxpg-gm:' + k); },
        list() { return Object.keys(localStorage).filter(k => k.startsWith('cxpg-gm:')).map(k => k.slice(9)); }
      };
      window.GM_setValue = (k, v) => store.set(k, v);
      window.GM_getValue = (k, v) => (store.get(k) === undefined ? v : store.get(k));
      window.GM_deleteValue = (k) => store.del(k);
      window.GM_listValues = () => store.list();
      window.GM_addStyle = (css) => { const el = document.createElement('style'); el.textContent = css; document.head.appendChild(el); return el; };
      window.GM_xmlhttpRequest = (options) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeout || 120000);
        fetch(options.url, { headers: options.headers, signal: controller.signal, credentials: 'include' })
          .then(async (response) => {
            const buffer = await response.arrayBuffer();
            const headers = [...response.headers].map(([k, v]) => k + ': ' + v).join('\\r\\n');
            if (options.responseType === 'arraybuffer') {
              options.onload?.({ status: response.status, response: buffer, responseHeaders: headers, finalUrl: response.url });
            } else {
              options.onload?.({ status: response.status, response: new TextDecoder().decode(buffer), responseHeaders: headers, finalUrl: response.url });
            }
          })
          .catch((error) => options.onerror?.({ error }))
          .finally(() => clearTimeout(timer));
      };
    })();
  `;
}

/* ------------------------- 测试主体 ------------------------- */

test("E2E：真实页面里跑通「全课 ZIP」与「设置/自检」", { skip: ENABLED ? false : REASON, timeout: 600000 }, async (t) => {
  assert.ok(COURSE_URL, "缺少 CXPG_COURSE_URL");
  const binary = pickBrowserBinary();
  const xvfb = await ensureDisplay();
  const profileDir = prepareProfile();
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const before = new Set(readdirSync(DOWNLOAD_DIR));

  const child = spawn(
    binary,
    [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${CDP_PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--ozone-platform=x11",
      "about:blank",
    ],
    { detached: true, stdio: "ignore", env: { ...process.env, DISPLAY, WAYLAND_DISPLAY: "" } },
  );

  let page = null;
  let browser = null;
  t.after(async () => {
    try {
      if (page?.targetId) await browser.send("Target.closeTarget", { targetId: page.targetId });
    } catch (_) {
      /* ignore */
    }
    browser?.close();
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (_) {
      /* 已退出 */
    }
    await sleep(1500);
    rmSync(profileDir, { recursive: true, force: true });
    if (xvfb) console.warn(`[e2e] 本次新建的 Xvfb ${DISPLAY} 保留未关（可能还有其他会话在用）`);
  });

  // 等 CDP 起来
  let version = null;
  for (let index = 0; index < 150; index += 1) {
    try {
      version = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
      break;
    } catch (_) {
      await sleep(400);
    }
  }
  assert.ok(version, `浏览器没能开调试端口 ${CDP_PORT}`);

  browser = await new CDP(version.webSocketDebuggerUrl).open();
  await sleep(3000); // 刚起来的浏览器渲染进程可能还没就绪，太早 enable 会一直没人应答
  await browser.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: DOWNLOAD_DIR,
    eventsEnabled: true,
  });

  // 实测：Target.createTarget 新建出来的 target 上 Page.enable 会挂死；
  // 直接 attach 启动时就存在的那个 about:blank 页面才正常。
  const targetInfos = (await browser.send("Target.getTargets")).targetInfos;
  const existing = targetInfos.find((item) => item.type === "page");
  assert.ok(existing, "浏览器里没有页面 target");
  const attached = await browser.send("Target.attachToTarget", { targetId: existing.targetId, flatten: true });
  page = browser;
  page.sessionId = attached.sessionId;
  page.targetId = existing.targetId;
  // Page.enable 在个别构建上会长时间无响应；它不是必需项（navigate/evaluate 都不依赖它）。
  await page.send("Page.enable", {}, page.sessionId, 8000).catch(() => {});
  await page.send("Runtime.enable", {}, page.sessionId, 15000).catch(() => {});

  // 导航（跨进程导航常常拿不到响应，容错处理）
  await page.send("Page.navigate", { url: COURSE_URL }, page.sessionId, 20000).catch(() => {});
  let ready = false;
  for (let index = 0; index < 120; index += 1) {
    await sleep(500);
    try {
      if ((await page.eval("document.readyState")) === "complete") {
        ready = true;
        break;
      }
    } catch (_) {
      /* 导航中执行上下文会丢，重试 */
    }
  }
  assert.ok(ready, "课程页没加载完");

  // 注入 GM 兼容层 + 用户脚本
  const source = readFileSync(USER_SCRIPT, "utf8");
  await page.eval(buildPrelude());
  await page.eval(source);

  // 等工具栏出现
  let diagnostics = "";
  let injected = false;
  for (let index = 0; index < 60; index += 1) {
    await sleep(500);
    const state = await page.eval(`JSON.stringify({
      toolbar: !!document.querySelector('.cxpg-toolbar'),
      tree: !!document.querySelector('#coursetree'),
      buttons: document.querySelectorAll('[data-cxpg-action]').length,
      title: document.title
    })`);
    const parsed = JSON.parse(state);
    if (parsed.toolbar) {
      injected = true;
      break;
    }
    diagnostics = state;
  }
  assert.ok(injected, `页面里没挂上工具栏，现场：${diagnostics}`);

  // 点「全课 PDF ZIP」
  await page.eval(`(() => {
    const button = document.querySelector('.cxpg-toolbar [data-cxpg-action="course:zip"]');
    if (!button) throw new Error('找不到全课 ZIP 按钮');
    button.click();
    return true;
  })()`);

  // 等进度面板给出结果
  let progressText = "";
  let done = false;
  const startedAt = Date.now();
  while (Date.now() - startedAt < TIMEOUT_ZIP_MS) {
    await sleep(700);
    const text = await page.eval(
      `(() => { const node = document.querySelector('.cxpg-progress'); return node ? node.innerText : ''; })()`,
    );
    progressText = text || progressText;
    // 进度面板的终态是「已完成」（toast 才是「已生成」）
    if (/已完成|已生成|失败|超过浏览器端 ZIP 上限|都下载失败/.test(progressText)) {
      done = true;
      break;
    }
  }
  assert.ok(done, `等 ZIP 超时，最后的进度：\n${progressText}`);
  assert.match(progressText, /已完成|已生成/, `ZIP 没生成成功：\n${progressText}`);

  // 等文件落盘（Chrome 落盘有十几秒延迟）
  let zipPath = "";
  for (let index = 0; index < 90; index += 1) {
    const now = readdirSync(DOWNLOAD_DIR).filter((name) => !before.has(name) && name !== "..");
    if (now.length) {
      const candidate = path.join(DOWNLOAD_DIR, now[0]);
      const first = statSync(candidate).size;
      await sleep(700);
      if (statSync(candidate).size === first && first > 0) {
        zipPath = candidate;
        break;
      }
    }
    await sleep(700);
  }
  assert.ok(zipPath, `下载目录里没出现文件：${DOWNLOAD_DIR}`);
  assert.ok(statSync(zipPath).size > 1024, "ZIP 太小，可能只写了个头");

  const entries = parseStoredZip(new Uint8Array(readFileSync(zipPath)));
  assert.ok(entries.length >= 1, "ZIP 里没有条目");
  assert.ok(entries.every((entry) => /\.pdf$/i.test(entry.name)), "ZIP 里有非 PDF 条目");
  const pdfMagic = Buffer.from("%PDF").toString("ascii");
  for (const entry of entries) {
    assert.equal(Buffer.from(entry.data.subarray(0, 4)).toString("ascii"), pdfMagic, `${entry.name} 不是 PDF`);
  }

  // 设置面板 + 接口自检
  await page.eval(`document.querySelector('[data-cxpg-action="settings"]').click()`);
  await sleep(800);
  const settingsText = await page.eval(
    `(() => { const node = document.getElementById('cxpg-settings-modal'); return node ? node.innerText : ''; })()`,
  );
  assert.match(settingsText, /设置与自检/);
  assert.match(settingsText, /版本/, "设置面板没显示版本行");
  const headerVersion = readFileSync(USER_SCRIPT, "utf8").match(/\/\/\s*@version\s+(\S+)/)[1];
  assert.ok(settingsText.includes(headerVersion), `面板版本与脚本头不一致：${settingsText.slice(0, 200)}`);

  await page.eval(`document.querySelector('[data-action="check"]').click()`);
  let checkText = "";
  let checked = false;
  for (let index = 0; index < 120; index += 1) {
    await sleep(500);
    checkText = await page.eval(
      `(() => { const node = document.querySelector('[data-role="check"]'); return node ? node.textContent : ''; })()`,
    );
    if (/^OK /.test(checkText) || /^失败：/.test(checkText)) {
      checked = true;
      break;
    }
  }
  assert.ok(checked, `自检没出结果：${checkText}`);
  assert.match(checkText, /^OK /, `自检失败：${checkText}`);

  assert.deepEqual(page.exceptions, [], `页面有未捕获异常：${page.exceptions.join(" | ")}`);
  const fatal = page.consoleErrors.filter((line) => /ReferenceError|TypeError|无法|Cannot access/.test(line));
  assert.deepEqual(fatal, [], `控制台有错误：${fatal.join(" | ")}`);
});
