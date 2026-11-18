// 单元测试：不碰浏览器、不碰网络，跑在 Node 内置 test runner 上。
//   node --test test/unit.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadUserScript, USER_SCRIPT } from "./harness.mjs";
import { crc32Ref, parseStoredZip } from "./zip.mjs";

const api = await loadUserScript();
test.after(() => api.__closeChannels());

/* ---------------- 0. 结构守卫 ---------------- */

test("主体可以求值（防 TDZ 回归：初始化阶段引用模块级 const 会抛 ReferenceError）", async () => {
  assert.ok(api.sanitizeFileName("a.pdf"));
  assert.equal(api.APP_VERSION, "1.1.0");
});

test("脚本头 @version 与 APP_VERSION 一致，STYLE_VERSION 有值", async () => {
  const source = await readFile(USER_SCRIPT, "utf8");
  const header = source.match(/\/\/\s*@version\s+(\S+)/);
  assert.ok(header, "缺少 @version");
  assert.equal(header[1], api.APP_VERSION, "@version 与 APP_VERSION 不一致");
  assert.match(api.STYLE_VERSION, /^\d+\.\d+\.\d+$/);
});

/* ---------------- 1. 文件名 ---------------- */

test("sanitizeFileName：非法字符、结尾空格与点号、空白折叠", () => {
  assert.equal(api.sanitizeFileName('a<b>c:d"e/f\\g|h?i*j'), "a_b_c_d_e_f_g_h_i_j");
  assert.equal(api.sanitizeFileName("绪论面授课件PPT_生化分离与纯化技术-绪论 .pptx "), "绪论面授课件PPT_生化分离与纯化技术-绪论 .pptx");
  assert.equal(api.sanitizeFileName("  第1章   绪论  "), "第1章 绪论");
  assert.equal(api.sanitizeFileName(""), "未命名");
  assert.equal(api.sanitizeFileName("..."), "未命名");
  assert.equal(api.sanitizeFileName(null), "未命名");
});

test("sanitizeFileName：Windows 保留名加下划线，普通名不动", () => {
  for (const name of ["CON", "con", "PRN", "aux", "NUL", "COM1", "lpt9", "con.pdf"]) {
    assert.ok(api.sanitizeFileName(name).startsWith("_"), `${name} 应该被前缀下划线`);
  }
  assert.equal(api.sanitizeFileName("console.pdf"), "console.pdf");
  assert.equal(api.sanitizeFileName("COM10.pdf"), "COM10.pdf");
});

test("sanitizeFileName：超长名截到 120 字符", () => {
  assert.equal(api.sanitizeFileName("x".repeat(200)).length, 120);
});

test("ensurePdfExtension / makeUniquePath", () => {
  assert.equal(api.ensurePdfExtension("a.pdf"), "a.pdf");
  assert.equal(api.ensurePdfExtension("a.PDF"), "a.PDF");
  assert.equal(api.ensurePdfExtension("a"), "a.pdf");
  const used = new Set();
  assert.equal(api.makeUniquePath(["课件", "绪论.pdf"], used), "课件/绪论.pdf");
  assert.equal(api.makeUniquePath(["课件", "绪论.pdf"], used), "课件/绪论 (2).pdf");
  assert.equal(api.makeUniquePath(["课件", "绪论.pdf"], used), "课件/绪论 (3).pdf");
});

/* ---------------- 2. 传输校验（对应「5 个文件全误报」那次事故） ---------------- */

test("verifyTransferSize：一致 / 容差内不报", () => {
  api.downloadIssues.reset();
  api.verifyTransferSize({ linkPath: "a.pdf" }, 1947485, "1947485", null);
  api.verifyTransferSize({ linkPath: "a.pdf" }, 1000, "1000", "identity");
  api.verifyTransferSize({ linkPath: "a.pdf" }, 1000, 1001, null); // 差 1 字节，在容差内
  assert.equal(api.downloadIssues.mismatched.length, 0);
});

test("verifyTransferSize：差距超容差记一条，不抛异常", () => {
  api.downloadIssues.reset();
  api.verifyTransferSize({ linkPath: "课件/绪论.pdf" }, 1947485, "64766752", null);
  assert.equal(api.downloadIssues.mismatched.length, 1);
  assert.equal(api.downloadIssues.mismatched[0].expected, 64766752);
  assert.equal(api.downloadIssues.mismatched[0].actual, 1947485);
});

test("verifyTransferSize：没有声明长度 / gzip 响应直接跳过", () => {
  api.downloadIssues.reset();
  api.verifyTransferSize({ linkPath: "a.pdf" }, 1234, "", null);
  api.verifyTransferSize({ linkPath: "a.pdf" }, 1234, 999999, "gzip");
  api.verifyTransferSize({ linkPath: "a.pdf" }, 0, 1234, null);
  assert.equal(api.downloadIssues.mismatched.length, 0);
});

test("parseResponseHeaders：大小写、冒号空白、多行", () => {
  const headers = api.parseResponseHeaders("Content-Length: 1947485\r\nContent-Encoding: gzip\r\nX-A: b\r\n");
  assert.equal(headers["content-length"], "1947485");
  assert.equal(headers["content-encoding"], "gzip");
  assert.equal(headers["x-a"], "b");
  assert.deepEqual(api.parseResponseHeaders(""), {});
  assert.deepEqual(api.parseResponseHeaders(null), {});
});

test("downloadIssues.reset 清空两类记录", () => {
  api.downloadIssues.failed.push({ linkPath: "x" });
  api.downloadIssues.mismatched.push({ label: "y" });
  api.downloadIssues.reset();
  assert.equal(api.downloadIssues.failed.length, 0);
  assert.equal(api.downloadIssues.mismatched.length, 0);
});

/* ---------------- 3. ZIP 体积风险 ---------------- */

test("getZipRisk：数量/体积超限拦下，正常放行", () => {
  assert.equal(api.getZipRisk([], 0).blocked, false);
  assert.equal(api.getZipRisk(new Array(api.ZIP_MAX_FILE_COUNT).fill({}), 0).blocked, false);
  const tooMany = api.getZipRisk(new Array(api.ZIP_MAX_FILE_COUNT + 1).fill({}), 0);
  assert.equal(tooMany.blocked, true);
  assert.match(tooMany.reason, /数量/);

  const tooBig = api.getZipRisk([{}], api.ZIP_THRESHOLD_BYTES);
  assert.equal(tooBig.blocked, true);
  assert.match(tooBig.reason, /体积/);
});

/* ---------------- 4. STORE ZIP 写入器（自解包校验） ---------------- */

test("createStoredZipBlob：路径、UTF-8 中文名、CRC、体积都对", async () => {
  const payloadA = new TextEncoder().encode("%PDF-1.4 fake pdf A");
  const payloadB = new TextEncoder().encode("%PDF-1.4 中文内容 B".repeat(3));
  const progress = [];
  const blob = await api.createStoredZipBlob(
    [
      { path: "示例课程/第1章/绪论.pdf", data: payloadA },
      { path: "示例课程/第2章/生物样品粗分离.pdf", data: payloadB.buffer.slice(payloadB.byteOffset, payloadB.byteOffset + payloadB.byteLength) },
    ],
    (current, total, detail) => progress.push([current, total, detail]),
  );
  assert.equal(blob.type, "application/zip");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const entries = parseStoredZip(bytes);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.name), [
    "示例课程/第1章/绪论.pdf",
    "示例课程/第2章/生物样品粗分离.pdf",
  ]);
  assert.equal(entries[0].method, 0, "必须是 STORE（不压缩）");
  assert.ok(entries[0].flags & 0x0800, "中文名要带 UTF-8 标志位");
  assert.equal(entries[0].crc, crc32Ref(payloadA));
  assert.equal(entries[1].crc, crc32Ref(payloadB));
  assert.deepEqual(Array.from(entries[0].data), Array.from(payloadA));
  assert.deepEqual(Array.from(entries[1].data), Array.from(payloadB));
  // 进度会分两段上报（先写本地头，再写中央目录），最后一条必须是 2/2。
  assert.ok(progress.length >= 2);
  assert.deepEqual(progress.at(-1).slice(0, 2), [2, 2]);
  assert.ok(progress.every((step) => step[1] === 2));
});

test("createStoredZipBlob：空列表直接报错", async () => {
  await assert.rejects(() => api.createStoredZipBlob([], () => {}), /没有可写入 ZIP/);
});

/* ---------------- 5. 让出主线程（对应「后台标签页假死」） ---------------- */

test("yieldToBrowser：200 次让出在 200ms 内完成（不依赖被节流的 setTimeout）", async () => {
  const started = Date.now();
  for (let index = 0; index < 200; index += 1) await api.yieldToBrowser();
  assert.ok(Date.now() - started < 200, "让出主线程过慢");
});

/* ---------------- 6. 解析工具 ---------------- */

test("extractKnowledgeId：多种写法", () => {
  assert.equal(api.extractKnowledgeId("chapterId=400000004"), "400000004");
  assert.equal(api.extractKnowledgeId("knowledgeid=400000005"), "400000005");
  assert.equal(api.extractKnowledgeId('"chapterId":400000006'), "400000006");
  assert.equal(api.extractKnowledgeId("getTeacherAjax('100000001','200000002','400000007')"), "400000007");
  assert.equal(api.extractKnowledgeId("knowledgeid：400000008"), "400000008");
  assert.equal(api.extractKnowledgeId("没有数字"), "");
  assert.equal(api.extractKnowledgeId(""), "");
});

test("getSearchParam：按顺序找第一个命中的参数", () => {
  const url = new URL("https://mooc1.chaoxing.com/x?courseId=100000001&clazzid=200000002");
  assert.equal(api.getSearchParam(url, ["courseid", "courseId"]), "100000001");
  assert.equal(api.getSearchParam(url, ["cpi"]), "");
  assert.equal(api.getSearchParam(null, ["courseId"]), "");
});

test("addObjectIdsFromText / addObjectIdCandidate：只收 32 位十六进制", () => {
  const set = new Set();
  api.addObjectIdCandidate(set, "9da995ea20de9485577e4addcad31537");
  api.addObjectIdCandidate(set, "9DA995EA20DE9485577E4ADDCAD31537");
  api.addObjectIdCandidate(set, "太短");
  api.addObjectIdsFromText(set, 'objectid="abcdef0123456789abcdef0123456789"');
  api.addObjectIdsFromText(set, "data-objectid=11111111222222223333333344444444");
  assert.ok(set.has("9da995ea20de9485577e4addcad31537"));
  assert.ok(set.has("abcdef0123456789abcdef0123456789"));
  assert.ok(set.has("11111111222222223333333344444444"));
  assert.equal(set.size, 3);
});

test("isUsableCourseName：占位标题不算课程名", () => {
  assert.equal(api.isUsableCourseName("生化分离与分析技术-2026-2027-1"), true);
  for (const value of ["学生学习页面", "章节", "目录", "课程门户", "学习通", ""]) {
    assert.equal(api.isUsableCourseName(value), false, `${value} 不该被当成课程名`);
  }
});

test("normalizeTree：去重 + 补齐路径片段", () => {
  const tree = {
    courseId: "100000001",
    clazzid: "200000002",
    cpi: "300000003",
    courseName: "示例课程",
    sections: [
      { id: "1", chapterDisplayName: "第一章 绪论", displayName: "1.1 课程说明" },
      { id: "1", chapterDisplayName: "第一章 绪论", displayName: "1.1 课程说明" },
      { id: "2", chapterDisplayName: "第一章 绪论", displayName: "1.5 绪论面授课件PPT" },
    ],
  };
  const result = api.normalizeTree(tree);
  assert.equal(result.sections.length, 2);
  assert.deepEqual(result.sections[1].pathParts, ["示例课程", "第一章 绪论", "1.5 绪论面授课件PPT"]);
  assert.equal(result.sections[1].courseId, "100000001");
});

test("parseLabelParts：按点号切成数字", () => {
  assert.deepEqual(api.parseLabelParts("1.5.2"), [1, 5, 2]);
  assert.deepEqual(api.parseLabelParts("2"), [2]);
  assert.deepEqual(api.parseLabelParts(""), [0]);
});

/* ---------------- 7. 杂项 ---------------- */

test("formatBytes / escapeHtml / escapeRegex / getErrorMessage", () => {
  assert.equal(api.formatBytes(0), "0.00 MB");
  assert.equal(api.formatBytes(1024 * 1024 * 1.5), "1.50 MB");
  assert.equal(api.formatBytes(1024 * 1024 * 1024 * 2), "2.00 GB");
  assert.equal(api.escapeHtml('<a href="x">&\'</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  assert.equal(api.escapeRegex("a.b*c"), "a\\.b\\*c");
  assert.equal(api.getErrorMessage(new Error("boom")), "boom");
  assert.equal(api.getErrorMessage("plain"), "plain");
  assert.equal(api.getErrorMessage(null), "未知错误");
});

test("mapLimit：并发受控、结果顺序与入参一致", async () => {
  let running = 0;
  let peak = 0;
  const input = [1, 2, 3, 4, 5, 6, 7];
  const result = await api.mapLimit(input, 3, async (value) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return value * 2;
  });
  assert.deepEqual(result, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(peak <= 3, `并发超了：${peak}`);
});
