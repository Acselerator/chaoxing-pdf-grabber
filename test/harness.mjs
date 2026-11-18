// 把用户脚本的 IIFE 主体取出来，在 Node 里用假 DOM 求值，导出其中的纯函数。
// 目的：不为了测试改动发布文件（导出语句留在测试侧）。
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const USER_SCRIPT = path.join(ROOT, "chaoxing-pdf-grabber.user.js");

export const EXPORTS = [
  "APP_NAME",
  "APP_VERSION",
  "STYLE_VERSION",
  "ZIP_THRESHOLD_BYTES",
  "ZIP_MAX_FILE_COUNT",
  "sanitizeFileName",
  "ensurePdfExtension",
  "makeUniquePath",
  "formatBytes",
  "parseLabelParts",
  "getZipRisk",
  "verifyTransferSize",
  "parseResponseHeaders",
  "downloadIssues",
  "createStoredZipBlob",
  "encodeUtf8",
  "toDosDateTime",
  "crc32",
  "yieldToBrowser",
  "escapeHtml",
  "escapeRegex",
  "getErrorMessage",
  "extractKnowledgeId",
  "getSearchParam",
  "addObjectIdsFromText",
  "addObjectIdCandidate",
  "isUsableCourseName",
  "normalizeTree",
  "mapLimit",
];

/** 造一个够用的假环境。 */
export function makeContext(overrides = {}) {
  const store = new Map();
  // 脚本在模块级 new MessageChannel()，不关掉端口 Node 进程不会退出。
  const channels = [];
  class TrackedMessageChannel extends MessageChannel {
    constructor() {
      super();
      channels.push(this);
    }
  }
  const listeners = [];
  const fakeDocument = {
    readyState: "complete",
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => ({
      style: {},
      setAttribute() {},
      appendChild() {},
      remove() {},
      addEventListener() {},
      click() {},
    }),
    documentElement: { dataset: {}, style: {} },
    body: { appendChild() {}, removeChild() {} },
    defaultView: null,
  };
  const context = {
    console,
    document: fakeDocument,
    window: {
      location: { href: "https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1" },
      addEventListener: () => {},
      parent: null,
      setTimeout,
      clearTimeout,
    },
    location: { href: "https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1" },
    navigator: { userAgent: "node-test" },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
      key: (index) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    },
    GM_setValue: (key, value) => store.set(key, value),
    GM_getValue: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    GM_deleteValue: (key) => store.delete(key),
    GM_listValues: () => Array.from(store.keys()),
    GM_addStyle: () => ({ remove() {} }),
    GM_xmlhttpRequest: () => {
      throw new Error("GM_xmlhttpRequest 不应在单元测试里被调用");
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    MessageChannel: TrackedMessageChannel,
    Blob,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    DataView,
    ArrayBuffer,
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    listeners,
  };
  context.__channels = channels;
  return Object.assign(context, overrides);
}

/**
 * 求值用户脚本主体。
 * - 去掉 "use strict"（要让 with(ctx) 生效）
 * - 跳过末尾的自动初始化（main()），否则会碰真 DOM
 * - 用 with(ctx) 让脚本里的全局引用命中假环境
 */
export async function loadUserScript(overrides) {
  const source = await readFile(USER_SCRIPT, "utf8");
  const startMarker = "(function () {";
  const start = source.indexOf(startMarker);
  const end = source.lastIndexOf("})();");
  if (start < 0 || end < 0) throw new Error("找不到 IIFE 边界，脚本结构变了？");

  let body = source.slice(start + startMarker.length, end);
  body = body.replace(/"use strict";/, "");
  body = body.replace(
    /if \(document\.readyState === "loading"\) \{[\s\S]*?\} else \{\s*main\(\);\s*\}/,
    "/* 单元测试里不自动初始化 */",
  );
  if (/\bmain\(\)\s*;/.test(body)) throw new Error("主体里仍有 main() 调用，测试会碰真 DOM");

  const factory = new Function(
    "ctx",
    `with (ctx) {\n${body}\nreturn { ${EXPORTS.join(", ")} };\n}`,
  );
  const context = makeContext(overrides);
  const api = factory(context);
  api.__closeChannels = () => {
    for (const channel of context.__channels) {
      try {
        channel.port1.close();
        channel.port2.close();
      } catch (_) {
        /* 已关闭 */
      }
    }
  };
  return api;
}

export const SOURCE_PATH = USER_SCRIPT;
