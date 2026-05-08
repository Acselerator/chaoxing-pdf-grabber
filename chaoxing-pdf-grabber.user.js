// ==UserScript==
// @name         学习通 PDF 抓取助手
// @namespace    https://github.com/Acselerator/chaoxing-pdf-grabber
// @version      1.0.0
// @description  在学习通课程章节页提取原始 PDF 直链，并支持小节直下、章节 STORE ZIP、全课 STORE ZIP 与超大包直链清单导出。
// @author       Acselerator
// @license      MIT
// @icon         https://raw.githubusercontent.com/Acselerator/chaoxing-pdf-grabber/main/assets/icons/icon-32.png
// @icon64       https://raw.githubusercontent.com/Acselerator/chaoxing-pdf-grabber/main/assets/icons/icon-64.png
// @homepage     https://github.com/Acselerator/chaoxing-pdf-grabber
// @supportURL   https://github.com/Acselerator/chaoxing-pdf-grabber/issues
// @match        *://mooc1.chaoxing.com/*
// @match        *://chaoxing.com/*
// @match        *://*.chaoxing.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      chaoxing.com
// @connect      *.chaoxing.com
// @connect      cldisk.com
// @connect      *.cldisk.com
// @run-at       document-idle
// @downloadURL https://update.greasyfork.org/scripts/577167/%E5%AD%A6%E4%B9%A0%E9%80%9A%20PDF%20%E6%8A%93%E5%8F%96%E5%8A%A9%E6%89%8B.user.js
// @updateURL https://update.greasyfork.org/scripts/577167/%E5%AD%A6%E4%B9%A0%E9%80%9A%20PDF%20%E6%8A%93%E5%8F%96%E5%8A%A9%E6%89%8B.meta.js
// ==/UserScript==

(function () {
  "use strict";

  const APP = "cxpg";
  const APP_NAME = "chaoxing-pdf-grabber";
  const STYLE_VERSION = "0.1.20";
  const ZIP_THRESHOLD_BYTES = 200 * 1024 * 1024;
  const ZIP_MAX_FILE_COUNT = 60;
  const CACHE_VERSION = 2;
  const METADATA_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const METADATA_CONCURRENCY = 3;
  const ZIP_FETCH_CONCURRENCY = 2;
  const DIRECT_DOWNLOAD_DELAY_MS = 600;
  const UI_REFRESH_DELAY_MS = 16;

  const CXPG_OWN_SELECTOR = [
    ".cxpg-toolbar",
    ".cxpg-actions",
    ".cxpg-btn",
    ".cxpg-toast-wrap",
    ".cxpg-toast",
    ".cxpg-progress",
    ".cxpg-modal-backdrop",
  ].join(",");

  const UI_REFRESH_SELECTOR = [
    "#coursetree",
    ".posCatalog_select",
    ".posCatalog_level",
    ".dataSearch_chapter",
    ".chapter",
    ".chapterList",
    ".courseChapter",
    "#chapter",
    "#chapterList",
    "iframe",
    "a[href*='studentstudy']",
    "a[href*='chapterId=']",
    "a[href*='knowledgeid=']",
    "[onclick*='studentstudy']",
    "[onclick*='getTeacherAjax']",
    "[onclick*='chapterId']",
    "[onclick*='knowledgeid']",
  ].join(",");

  const injectedDocuments = new WeakSet();
  const observedDocuments = new WeakSet();
  const attachedFrames = new WeakSet();
  let liveExtractionChain = Promise.resolve();

  const styleText = `
    .cxpg-toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 10px 20px;
      min-height: 28px;
      flex-wrap: wrap;
      font-family: "Microsoft YaHei", Arial, sans-serif;
    }
    .cxpg-toolbar-title {
      color: #131b26;
      font-size: 13px;
      font-weight: 600;
      white-space: nowrap;
    }
    .cxpg-actions {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      pointer-events: none;
    }
    .cxpg-actions > .cxpg-btn {
      pointer-events: auto;
    }
    .cxpg-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      min-width: 72px;
      height: 28px;
      padding: 0 10px;
      border: 1px solid #2f7df6;
      border-radius: 4px;
      background: #2f7df6;
      color: #fff !important;
      cursor: pointer;
      font: 12px/1 "Microsoft YaHei", Arial, sans-serif;
      text-decoration: none !important;
      white-space: nowrap;
      user-select: none;
      transition: background .15s ease, border-color .15s ease, opacity .15s ease;
    }
    .cxpg-btn:hover {
      background: #1f67d8;
      border-color: #1f67d8;
    }
    .cxpg-btn:disabled,
    .cxpg-btn.cxpg-busy {
      cursor: wait;
      opacity: .72;
    }
    .cxpg-btn-secondary {
      background: #fff;
      border-color: #d6dbe6;
      color: #2f3b52 !important;
    }
    .cxpg-btn-secondary:hover {
      background: #f6f8fc;
      border-color: #c7cfdf;
    }
    .cxpg-btn-small {
      min-width: 54px;
      height: 22px;
      padding: 0 7px;
      font-size: 12px;
    }
    .posCatalog_select.cxpg-row-action {
      position: relative !important;
      box-sizing: border-box;
    }
    .posCatalog_select.cxpg-row-action > .posCatalog_name,
    .posCatalog_select.cxpg-row-action > .posCatalog_title {
      display: block;
      box-sizing: border-box;
      padding-right: 118px !important;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
    }
    .posCatalog_select.cxpg-row-action > .prevTips,
    .posCatalog_select.cxpg-row-action > .catalog_points_yi,
    .posCatalog_select.cxpg-row-action > .icon_Completed {
      z-index: 1000 !important;
    }
    .posCatalog_select.cxpg-row-action > .prevTips > .prevHoverTips {
      z-index: 1001 !important;
    }
    .posCatalog_select.cxpg-row-action > .cxpg-actions {
      position: absolute;
      right: 52px;
      top: 50%;
      z-index: 30;
      transform: translateY(-50%);
      margin: 0;
    }
    .posCatalog_select.firstLayer.cxpg-row-action > .posCatalog_title {
      padding-right: 96px !important;
    }
    .posCatalog_select.firstLayer.cxpg-row-action > .cxpg-actions {
      right: 20px;
    }
    .cxpg-toast-wrap {
      position: fixed;
      right: 24px;
      bottom: 150px;
      z-index: 2147483600;
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;
      font-family: "Microsoft YaHei", Arial, sans-serif;
    }
    .cxpg-toast {
      max-width: 360px;
      padding: 10px 12px;
      border-radius: 6px;
      background: rgba(24, 30, 51, .94);
      color: #fff;
      box-shadow: 0 10px 30px rgba(0, 0, 0, .18);
      font-size: 13px;
      line-height: 1.45;
      pointer-events: auto;
    }
    .cxpg-toast-error {
      background: rgba(174, 43, 43, .96);
    }
    .cxpg-toast-success {
      background: rgba(25, 119, 82, .96);
    }
    .cxpg-progress {
      position: fixed;
      right: 24px;
      bottom: 28px;
      z-index: 2147483598;
      width: min(420px, calc(100vw - 48px));
      padding: 14px 16px 16px;
      border-radius: 8px;
      background: #fff;
      color: #172033;
      box-shadow: 0 18px 54px rgba(15, 23, 42, .22);
      font-family: "Microsoft YaHei", Arial, sans-serif;
      border: 1px solid #e6ebf3;
    }
    .cxpg-progress-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }
    .cxpg-progress-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 14px;
      font-weight: 700;
    }
    .cxpg-progress-close {
      width: 22px;
      height: 22px;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: #667085;
      cursor: pointer;
      font-size: 18px;
      line-height: 20px;
      flex: 0 0 auto;
    }
    .cxpg-progress-close:hover {
      background: #f2f4f7;
      color: #101828;
    }
    .cxpg-progress-status {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
      color: #344054;
      font-size: 13px;
      line-height: 1.35;
    }
    .cxpg-progress-detail {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #667085;
      font-size: 12px;
      min-height: 16px;
      margin-top: 8px;
    }
    .cxpg-progress-track {
      height: 8px;
      overflow: hidden;
      border-radius: 99px;
      background: #edf2f7;
    }
    .cxpg-progress-bar {
      height: 100%;
      width: 0%;
      border-radius: inherit;
      background: #2f7df6;
      transition: width .2s ease;
    }
    .cxpg-modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 2147483599;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: rgba(15, 23, 42, .48);
      backdrop-filter: blur(5px);
      font-family: "Microsoft YaHei", Arial, sans-serif;
    }
    .cxpg-modal {
      position: relative;
      width: min(520px, calc(100vw - 48px));
      border-radius: 10px;
      background: #fff;
      box-shadow: 0 24px 72px rgba(15, 23, 42, .28);
      overflow: hidden;
    }
    .cxpg-modal-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 22px 24px 10px;
      color: #111827;
    }
    .cxpg-modal-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: #fff3cd;
      color: #b45309;
      font-size: 18px;
      line-height: 1;
      flex: 0 0 auto;
    }
    .cxpg-modal-title {
      margin: 0;
      font-size: 18px;
      line-height: 1.35;
      font-weight: 700;
    }
    .cxpg-modal-close {
      position: absolute;
      top: 12px;
      right: 12px;
      width: 30px;
      height: 30px;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: #6b7280;
      cursor: pointer;
      font-size: 22px;
      line-height: 30px;
    }
    .cxpg-modal-close:hover {
      background: #f3f4f6;
      color: #111827;
    }
    .cxpg-modal-body {
      padding: 8px 24px 20px;
      color: #374151;
      font-size: 14px;
      line-height: 1.65;
    }
    .cxpg-modal-size {
      margin: 12px 0 0;
      padding: 10px 12px;
      border-radius: 6px;
      background: #f8fafc;
      color: #111827;
      font-weight: 700;
    }
    .cxpg-modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      padding: 16px 24px 22px;
      border-top: 1px solid #eef1f6;
    }
  `;

  function main() {
    addStylesOnce(document);
    initDocument(document);
    observeDocument(document);
    attachKnownFrames(document);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main, { once: true });
  } else {
    main();
  }

  function addStylesOnce(doc) {
    const existing = doc.getElementById(`${APP}-style`);
    if (existing) {
      if (existing.dataset.styleVersion === STYLE_VERSION) return;
      if (existing.tagName === "STYLE") {
        existing.textContent = styleText;
        existing.dataset.styleVersion = STYLE_VERSION;
        return;
      }
      existing.remove();
    }

    if (typeof GM_addStyle === "function" && doc === document) {
      GM_addStyle(styleText);
      const marker = doc.createElement("meta");
      marker.id = `${APP}-style`;
      marker.setAttribute("data-source", "GM_addStyle");
      marker.dataset.styleVersion = STYLE_VERSION;
      doc.head.appendChild(marker);
      return;
    }

    const style = doc.createElement("style");
    style.id = `${APP}-style`;
    style.dataset.styleVersion = STYLE_VERSION;
    style.textContent = styleText;
    (doc.head || doc.documentElement).appendChild(style);
  }

  function initDocument(doc) {
    if (!doc || !doc.documentElement) return;
    addStylesOnce(doc);
    injectCourseTreeUi(doc);
    injectGenericOverviewUi(doc);
  }

  function observeDocument(doc) {
    if (!doc || observedDocuments.has(doc) || !doc.documentElement) return;
    observedDocuments.add(doc);

    let refreshScheduled = false;
    const observer = new MutationObserver((records) => {
      if (!shouldRefreshUiForMutations(records)) return;
      if (refreshScheduled) return;
      refreshScheduled = true;
      setTimeout(() => {
        refreshScheduled = false;
        initDocument(doc);
        attachKnownFrames(doc);
      }, UI_REFRESH_DELAY_MS);
    });

    observer.observe(doc.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function shouldRefreshUiForMutations(records) {
    for (const record of records) {
      if (record.type !== "childList") continue;

      const changedElements = Array.from(record.addedNodes)
        .concat(Array.from(record.removedNodes))
        .filter((node) => node.nodeType === Node.ELEMENT_NODE);

      if (changedElements.length === 0) continue;
      if (changedElements.every(isCxpgOwnedElement)) continue;

      if (isUiRefreshElement(record.target, false)) return true;
      if (changedElements.some((element) => isUiRefreshElement(element, true))) return true;
    }
    return false;
  }

  function isCxpgOwnedElement(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    const element = node;
    if (element.id === `${APP}-style`) return true;
    if (typeof element.matches === "function" && element.matches(CXPG_OWN_SELECTOR)) return true;
    return typeof element.closest === "function" && Boolean(element.closest(CXPG_OWN_SELECTOR));
  }

  function isUiRefreshElement(node, includeDescendants) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE || isCxpgOwnedElement(node)) return false;
    const element = node;
    if (safeMatches(element, UI_REFRESH_SELECTOR)) return true;
    if (typeof element.closest === "function" && Boolean(element.closest("#coursetree"))) return true;
    return includeDescendants && typeof element.querySelector === "function" && Boolean(safeQuery(element, UI_REFRESH_SELECTOR));
  }

  function safeMatches(element, selector) {
    try {
      return typeof element.matches === "function" && element.matches(selector);
    } catch (_) {
      return false;
    }
  }

  function safeQuery(element, selector) {
    try {
      return element.querySelector(selector);
    } catch (_) {
      return null;
    }
  }

  function attachKnownFrames(doc) {
    const frames = Array.from(doc.querySelectorAll("iframe"));
    for (const frame of frames) {
      if (attachedFrames.has(frame)) continue;
      attachedFrames.add(frame);

      const tryInitFrame = () => {
        try {
          if (!frame.contentDocument || !frame.contentDocument.documentElement) return;
          addStylesOnce(frame.contentDocument);
          initDocument(frame.contentDocument);
          observeDocument(frame.contentDocument);
        } catch (_) {
          // Cross-origin iframes will be handled by Tampermonkey's own iframe injection when allowed.
        }
      };

      frame.addEventListener("load", () => setTimeout(tryInitFrame, 300));
      tryInitFrame();
    }
  }

  function injectCourseTreeUi(doc) {
    const root = doc.getElementById("coursetree");
    if (!root) return;

    const tree = buildCourseTreeFromCatalog(doc);
    if (!tree || tree.sections.length === 0) return;

    let toolbar = root.parentElement?.querySelector(":scope > .cxpg-toolbar");
    if (!toolbar) {
      root.dataset.cxpgToolbar = "1";
      toolbar = doc.createElement("div");
      toolbar.className = "cxpg-toolbar";
      toolbar.innerHTML = `<span class="cxpg-toolbar-title">PDF 提取</span>`;

      const anchor = root.previousElementSibling && root.previousElementSibling.classList.contains("dataSearch_chapter")
        ? root.previousElementSibling
        : root;
      anchor.parentElement.insertBefore(toolbar, anchor);
    }
    if (!toolbar.querySelector(":scope > .cxpg-btn[data-cxpg-action='course:zip']")) {
      const allButton = createButton(doc, "全课 PDF ZIP", "cxpg-btn");
      allButton.dataset.cxpgAction = "course:zip";
      bindButtonClick(doc, allButton, () => {
        handleZipDownload(doc, "course", null, allButton);
      });
      toolbar.appendChild(allButton);
    }

    for (const chapter of tree.chapters) {
      if (!chapter.domNode) continue;
      chapter.domNode.dataset.cxpgChapterInjected = "1";
      ensureActionButton(doc, chapter.domNode, `chapter:${chapter.id}`, "本章 ZIP", "cxpg-btn cxpg-btn-small", (button) => {
        handleZipDownload(doc, "chapter", chapter.id, button);
      });
    }

    for (const section of tree.sections) {
      if (!section.domNode) continue;
      section.domNode.dataset.cxpgSectionInjected = "1";
      ensureActionButton(doc, section.domNode, `section:${section.id}`, "PDF", "cxpg-btn cxpg-btn-small cxpg-btn-secondary", (button) => {
        const latestTree = buildCourseTreeFromCatalog(doc);
        const latestSection = latestTree?.sections.find((item) => item.id === section.id) || section;
        handleSectionDownload(doc, latestSection, button);
      });
    }
  }

  function injectGenericOverviewUi(doc) {
    if (doc.getElementById("coursetree")) return;
    if (injectedDocuments.has(doc)) return;

    const tree = buildCourseTreeFromGenericDocument(doc);
    if (!tree || tree.sections.length < 2) return;

    injectedDocuments.add(doc);

    const toolbar = doc.createElement("div");
    toolbar.className = "cxpg-toolbar";
    toolbar.innerHTML = `<span class="cxpg-toolbar-title">PDF 提取</span>`;
    const allButton = createButton(doc, "全课 PDF ZIP", "cxpg-btn");
    bindButtonClick(doc, allButton, () => {
      handleZipDownload(doc, "course", null, allButton);
    });
    toolbar.appendChild(allButton);

    const anchor =
      doc.querySelector(".chapter, .chapterList, .courseChapter, #chapter, #chapterList, main, body") ||
      doc.body;
    anchor.insertBefore(toolbar, anchor.firstChild);

    for (const chapter of tree.chapters) {
      if (!chapter.domNode) continue;
      chapter.domNode.dataset.cxpgChapterInjected = "1";
      ensureActionButton(doc, chapter.domNode, `chapter:${chapter.id}`, "本章 ZIP", "cxpg-btn cxpg-btn-small", (button) => {
        handleZipDownload(doc, "chapter", chapter.id, button);
      });
    }

    for (const section of tree.sections) {
      if (!section.domNode) continue;
      section.domNode.dataset.cxpgSectionInjected = "1";
      ensureActionButton(doc, section.domNode, `section:${section.id}`, "PDF", "cxpg-btn cxpg-btn-small cxpg-btn-secondary", (button) => {
        const latestTree = buildCourseTree(doc);
        const latestSection = latestTree?.sections.find((item) => item.id === section.id) || section;
        handleSectionDownload(doc, latestSection, button);
      });
    }
  }

  function createButton(doc, text, className) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    button.dataset.cxpgButton = "1";
    button.addEventListener("pointerdown", stopCatalogPointerEvent, true);
    button.addEventListener("mousedown", stopCatalogPointerEvent, true);
    return button;
  }

  function bindButtonClick(doc, button, action) {
    let lastRunAt = 0;
    const activate = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }

      if (button.disabled) return false;
      const now = Date.now();
      if (now - lastRunAt < 800) return false;
      lastRunAt = now;

      showToast(doc, "已收到点击，开始处理。", "info", 1200);
      Promise.resolve()
        .then(action)
        .catch((error) => {
          console.error(`[${APP_NAME}] Button action failed`, error);
          showToast(doc, `执行失败：${getErrorMessage(error)}`, "error", 6000);
        });

      return false;
    };

    button.addEventListener("pointerup", activate, true);
    button.addEventListener("click", activate, true);
    button.onclick = activate;
  }

  function ensureActionsContainer(doc, target) {
    target.classList.add("cxpg-row-action");
    let container = target.querySelector(":scope > .cxpg-actions");
    if (!container) {
      container = doc.createElement("span");
      container.className = "cxpg-actions";
      target.appendChild(container);
    }
    return container;
  }

  function ensureActionButton(doc, target, actionKey, text, className, action) {
    const actions = ensureActionsContainer(doc, target);
    const existing = Array.from(actions.children).find((child) => child.dataset?.cxpgAction === actionKey);
    if (existing) return existing;

    const button = createButton(doc, text, className);
    button.dataset.cxpgAction = actionKey;
    bindButtonClick(doc, button, () => action(button));
    actions.appendChild(button);
    return button;
  }

  function stopCatalogPointerEvent(event) {
    event.stopPropagation();
  }

  async function handleZipDownload(doc, scopeType, chapterId, button) {
    const restore = setButtonBusy(button, "解析中");
    let progressPanel = null;
    try {
      const tree = buildCourseTree(doc);
      if (!tree || tree.sections.length === 0) {
        showToast(doc, "未识别到课程章节树。", "error");
        return;
      }

      const scopeSections = scopeType === "chapter"
        ? tree.sections.filter((section) => section.chapterId === chapterId)
        : tree.sections;

      if (scopeSections.length === 0) {
        showToast(doc, "该范围内没有可解析的小节。", "error");
        return;
      }

      const scopeName = scopeType === "chapter"
        ? (tree.chapters.find((chapter) => chapter.id === chapterId)?.displayName || "本章")
        : tree.courseName;

      progressPanel = createProgressPanel(doc, `${scopeName} PDF ZIP`);
      const progress = createProgressReporter(doc, button, progressPanel);
      progress({
        stage: "解析直链",
        current: 0,
        total: scopeSections.length,
        detail: "正在读取章节卡片和 PDF 元数据",
      });
      const records = await collectPdfRecords(doc, tree, scopeSections, progress);

      if (records.length === 0) {
        progressPanel.update({
          stage: "未发现 PDF",
          current: 0,
          total: 1,
          detail: "这个范围内没有解析到 PDF 课件",
        });
        showToast(doc, "未发现 PDF 课件。", "error");
        return;
      }

      const totalBytes = records.reduce((sum, item) => sum + (Number(item.length) || 0), 0);
      const zipRisk = getZipRisk(records, totalBytes);
      if (zipRisk.blocked) {
        progressPanel.update({
          stage: "已停止",
          current: 1,
          total: 1,
          detail: zipRisk.reason,
        });
        renderOomModal(doc, {
          scopeName,
          totalBytes,
          records,
          zipName: scopeType === "chapter" ? `${scopeName}.zip` : `${tree.courseName}.zip`,
          exportName: `${scopeName}课件直链清单.txt`,
          reason: zipRisk.reason,
          onForceZip: async () => {
            const forceRestore = setButtonBusy(button, "强制生成");
            const forcePanel = createProgressPanel(doc, `${scopeName} PDF ZIP`);
            const forceProgress = createProgressReporter(doc, button, forcePanel);
            try {
              forceProgress({
                stage: "下载 PDF",
                current: 0,
                total: records.length,
                detail: "已无视风险，开始生成 STORE ZIP",
              });
              await downloadZip(
                doc,
                tree,
                records,
                scopeType === "chapter" ? `${scopeName}.zip` : `${tree.courseName}.zip`,
                forceProgress
              );
              forcePanel.update({
                stage: "已完成",
                current: 1,
                total: 1,
                detail: scopeType === "chapter" ? `${scopeName}.zip` : `${tree.courseName}.zip`,
              });
              showToast(doc, "已生成 ZIP。", "success");
            } catch (error) {
              console.error(`[${APP_NAME}] Forced ZIP failed`, error);
              forcePanel.update({
                stage: "失败",
                current: 1,
                total: 1,
                detail: getErrorMessage(error),
              });
              showToast(doc, `强制生成 ZIP 失败：${getErrorMessage(error)}`, "error", 7000);
            } finally {
              forceRestore();
              forcePanel.close(2200);
            }
          },
        });
        return;
      }

      setButtonText(button, "打包中");
      const zipName = scopeType === "chapter"
        ? `${scopeName}.zip`
        : `${tree.courseName}.zip`;
      await downloadZip(doc, tree, records, zipName, progress);
      progressPanel.update({
        stage: "已完成",
        current: 1,
        total: 1,
        detail: sanitizeFileName(zipName),
      });
      showToast(doc, `已生成 ${sanitizeFileName(zipName)}`, "success");
    } catch (error) {
      console.error(`[${APP_NAME}] ZIP download failed`, error);
      if (progressPanel) {
        progressPanel.update({
          stage: "失败",
          current: 1,
          total: 1,
          detail: getErrorMessage(error),
        });
      }
      showToast(doc, `下载失败：${getErrorMessage(error)}`, "error", 6000);
    } finally {
      restore();
      if (progressPanel) progressPanel.close(1800);
    }
  }

  async function handleSectionDownload(doc, section, button) {
    const restore = setButtonBusy(button, "解析中");
    try {
      const tree = buildCourseTree(doc);
      const latestSection = tree.sections.find((item) => item.id === section.id) || section;
      const progress = createProgressReporter(doc, button, null);
      const records = await collectPdfRecords(doc, tree, [latestSection], progress);

      if (records.length === 0) {
        showToast(doc, "该小节未发现 PDF。", "error");
        return;
      }

      setButtonText(button, "下载中");
      await downloadDirectPdfs(doc, records, progress);
      showToast(doc, `已下载 ${records.length} 个 PDF。`, "success");
    } catch (error) {
      console.error(`[${APP_NAME}] Section download failed`, error);
      showToast(doc, `下载失败：${getErrorMessage(error)}`, "error", 6000);
    } finally {
      restore();
    }
  }

  function buildCourseTree(doc) {
    return buildCourseTreeFromCatalog(doc) || buildCourseTreeFromGenericDocument(doc);
  }

  function buildCourseTreeFromCatalog(doc) {
    const root = doc.getElementById("coursetree");
    if (!root) return null;

    const context = getCourseContext(doc);
    const chapters = [];
    const sections = [];
    const firstLayerNodes = Array.from(root.querySelectorAll(".posCatalog_select.firstLayer"));

    for (const [chapterIndex, chapterNode] of firstLayerNodes.entries()) {
      const chapterId = getKnowledgeIdFromElement(chapterNode) || `chapter-${chapterIndex + 1}`;
      const chapterLabel = getNodeLabel(chapterNode);
      const chapterTitle = getNodeTitle(chapterNode) || `章节 ${chapterIndex + 1}`;
      const chapter = {
        id: chapterId,
        label: chapterLabel || String(chapterIndex + 1),
        title: chapterTitle,
        displayName: composeDisplayName(chapterLabel, chapterTitle),
        domNode: chapterNode,
      };
      chapters.push(chapter);

      const chapterLi = chapterNode.closest("li") || chapterNode.parentElement;
      const sectionNodes = Array.from(chapterLi.querySelectorAll(".posCatalog_select:not(.firstLayer)"));
      for (const sectionNode of sectionNodes) {
        const nameNode = sectionNode.querySelector(".posCatalog_name");
        if (!nameNode) continue;

        const id = getKnowledgeIdFromElement(sectionNode) || getKnowledgeIdFromElement(nameNode);
        if (!id) continue;

        const sectionLi = sectionNode.closest("li");
        const childSections = sectionLi
          ? Array.from(sectionLi.children).some((child) => child.tagName === "UL" || child.classList?.contains("posCatalog_level"))
          : false;
        const label = getNodeLabel(sectionNode);
        const title = getNodeTitle(sectionNode) || `小节 ${id}`;

        sections.push({
          id,
          label,
          title,
          displayName: composeDisplayName(label, title),
          chapterId: chapter.id,
          chapterLabel: chapter.label,
          chapterTitle: chapter.title,
          chapterDisplayName: chapter.displayName,
          domNode: sectionNode,
          isLeaf: !childSections,
        });
      }
    }

    return normalizeTree({
      ...context,
      chapters,
      sections,
      source: "catalog",
    });
  }

  function buildCourseTreeFromGenericDocument(doc) {
    if (!isLikelyCourseDocument(doc)) return null;

    const context = getCourseContext(doc);
    const candidateMap = new Map();
    const selector = [
      "a[href*='studentstudy']",
      "a[href*='chapterId=']",
      "a[href*='knowledgeid=']",
      "[onclick*='studentstudy']",
      "[onclick*='getTeacherAjax']",
      "[onclick*='chapterId']",
      "[onclick*='knowledgeid']",
    ].join(",");

    for (const element of Array.from(doc.querySelectorAll(selector))) {
      const raw = `${element.getAttribute("href") || ""} ${element.getAttribute("onclick") || ""}`;
      const id = extractKnowledgeId(raw);
      if (!id || candidateMap.has(id)) continue;

      const row = getLikelyRow(element);
      const rowText = cleanText(row?.textContent || element.textContent || "");
      const label = extractSectionLabel(rowText) || extractSectionLabel(element.textContent || "");
      const title =
        element.getAttribute("title") ||
        row?.getAttribute("title") ||
        stripLeadingLabel(rowText) ||
        `小节 ${id}`;

      candidateMap.set(id, {
        id,
        label,
        title: normalizeTitle(title),
        displayName: composeDisplayName(label, normalizeTitle(title)),
        domNode: row || element,
        rawText: rowText,
      });
    }

    const candidates = Array.from(candidateMap.values())
      .filter((item) => item.title && !/^(章节|目录)$/.test(item.title))
      .sort(compareByLabel);

    if (candidates.length === 0) return null;

    const chaptersByKey = new Map();
    const chapters = [];
    const sections = [];

    for (const item of candidates) {
      const chapterKey = getChapterKey(item.label) || "1";
      if (!chaptersByKey.has(chapterKey)) {
        const chapterTitle = findGenericChapterTitle(doc, chapterKey, item) || `第 ${chapterKey} 章`;
        const chapter = {
          id: `generic-${chapterKey}`,
          label: chapterKey,
          title: normalizeTitle(chapterTitle),
          displayName: composeDisplayName(chapterKey, normalizeTitle(chapterTitle)),
          domNode: findGenericChapterNode(doc, chapterKey, item.domNode) || item.domNode,
        };
        chaptersByKey.set(chapterKey, chapter);
        chapters.push(chapter);
      }

      const chapter = chaptersByKey.get(chapterKey);
      sections.push({
        ...item,
        chapterId: chapter.id,
        chapterLabel: chapter.label,
        chapterTitle: chapter.title,
        chapterDisplayName: chapter.displayName,
        isLeaf: true,
      });
    }

    return normalizeTree({
      ...context,
      chapters,
      sections,
      source: "generic",
    });
  }

  function normalizeTree(tree) {
    const seen = new Set();
    tree.sections = tree.sections.filter((section) => {
      if (seen.has(section.id)) return false;
      seen.add(section.id);
      return true;
    });

    for (const section of tree.sections) {
      section.courseId = tree.courseId;
      section.clazzid = tree.clazzid;
      section.cpi = tree.cpi;
      section.courseName = tree.courseName;
      section.pathParts = [
        tree.courseName,
        section.chapterDisplayName,
        section.displayName,
      ].filter(Boolean);
    }

    return tree;
  }

  function getCourseContext(doc) {
    const currentUrl = safeUrl(doc.defaultView?.location?.href || location.href);
    const parentDoc = getParentDocument(doc);
    const text = getInlineScriptText(doc);

    const courseId =
      getInputValue(doc, ["curCourseId", "courseid", "courseId"]) ||
      getSearchParam(currentUrl, ["courseid", "courseId"]) ||
      getRegexValue(text, /(?:stu_CourseId|courseId|courseid)\s*=\s*["']?(\d+)/i);

    const clazzid =
      getInputValue(doc, ["curClazzId", "clazzid", "clazzId", "classId"]) ||
      getSearchParam(currentUrl, ["clazzid", "clazzId", "classId"]) ||
      getRegexValue(text, /(?:stu_clazzId|clazzid|clazzId|classId)\s*=\s*["']?(\d+)/i);

    const cpi =
      getInputValue(doc, ["cpi", "curCpi"]) ||
      getSearchParam(currentUrl, ["cpi"]) ||
      getRegexValue(text, /(?:stu_cpi|cpi)\s*=\s*["']?(\d+)/i) ||
      "";

    const courseName =
      readCourseName(doc) ||
      (parentDoc ? readCourseName(parentDoc) : "") ||
      "学习通课程";

    return {
      courseId: courseId || "",
      clazzid: clazzid || "",
      cpi,
      courseName: sanitizeFileName(courseName),
      courseKey: [
        courseId || "unknown-course",
        clazzid || "unknown-class",
        cpi || "unknown-cpi",
      ].join(":"),
    };
  }

  function readCourseName(doc) {
    const selectors = [
      ".textHidden.colorDeep[title]",
      "[class*='course'][class*='name'][title]",
      "[class*='course'][class*='title'][title]",
      "dd[title]",
    ];

    for (const selector of selectors) {
      const node = doc.querySelector(selector);
      const value = normalizeTitle(node?.getAttribute("title") || node?.textContent || "");
      if (isUsableCourseName(value)) return value;
    }

    const scriptText = getInlineScriptText(doc);
    const fromCollection = getRegexValue(scriptText, /collectionname\s*:\s*['"]([^'"]+)['"]/i);
    if (isUsableCourseName(fromCollection)) return normalizeTitle(fromCollection);

    const fromJson = getRegexValue(scriptText, /"courseName"\s*:\s*"([^"]+)"/i);
    if (isUsableCourseName(fromJson)) return normalizeTitle(fromJson);

    const title = normalizeTitle(doc.title || "");
    if (isUsableCourseName(title)) return title;

    return "";
  }

  function isUsableCourseName(value) {
    if (!value) return false;
    return !/^(学生学习页面|章节|目录|课程门户|学习通)$/i.test(value);
  }

  function getParentDocument(doc) {
    try {
      if (doc.defaultView?.parent && doc.defaultView.parent !== doc.defaultView) {
        return doc.defaultView.parent.document;
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  function getInputValue(doc, ids) {
    for (const id of ids) {
      const node = doc.getElementById(id);
      if (node && node.value) return String(node.value).trim();
    }
    return "";
  }

  function getSearchParam(url, names) {
    if (!url) return "";
    for (const name of names) {
      const value = url.searchParams.get(name);
      if (value) return value;
    }
    return "";
  }

  function getInlineScriptText(doc) {
    return Array.from(doc.scripts || [])
      .map((script) => script.textContent || "")
      .join("\n");
  }

  function getRegexValue(text, regex) {
    const match = text ? text.match(regex) : null;
    return match ? match[1] : "";
  }

  function getNodeLabel(node) {
    const labelNode = node.querySelector(".posCatalog_sbar, em");
    const text = cleanText(labelNode?.textContent || "");
    return text || extractSectionLabel(node.textContent || "");
  }

  function getNodeTitle(node) {
    const titleNode = node.querySelector(".posCatalog_title, .posCatalog_name, [title]");
    const attrTitle = titleNode?.getAttribute("title") || node.getAttribute("title") || "";
    const text = attrTitle || titleNode?.textContent || node.textContent || "";
    return normalizeTitle(stripLeadingLabel(text));
  }

  function getKnowledgeIdFromElement(element) {
    if (!element) return "";
    const id = element.getAttribute("id") || "";
    const fromId = id.match(/^(?:cur)?(\d{5,})$/);
    if (fromId) return fromId[1];

    const raw = [
      element.getAttribute("onclick") || "",
      element.getAttribute("href") || "",
      element.outerHTML || "",
    ].join(" ");
    return extractKnowledgeId(raw);
  }

  function extractKnowledgeId(raw) {
    if (!raw) return "";

    const decoded = tryDecode(raw);
    const samples = raw === decoded ? [raw] : [raw, decoded];

    for (const sample of samples) {
      const ajaxMatch = sample.match(/getTeacherAjax\s*\(\s*['"]?\d+['"]?\s*,\s*['"]?\d+['"]?\s*,\s*['"]?(\d{5,})/i);
      if (ajaxMatch) return ajaxMatch[1];

      const paramMatch = sample.match(/(?:chapterId|chapterid|knowledgeid|knowledgeId|nodeid)\s*=\s*["']?(\d{5,})/i);
      if (paramMatch) return paramMatch[1];

      const jsonMatch = sample.match(/(?:chapterId|knowledgeid|knowledgeId|nodeid)["']?\s*[:：]\s*["']?(\d{5,})/i);
      if (jsonMatch) return jsonMatch[1];
    }

    return "";
  }

  async function collectPdfRecords(doc, tree, sections, progress) {
    const cache = await readMetadataCache(tree.courseKey);
    const recordsByObjectId = new Map();
    const failures = [];
    let completed = 0;

    await mapLimit(sections, METADATA_CONCURRENCY, async (section) => {
      progress({
        stage: "解析直链",
        current: completed,
        total: sections.length,
        detail: section.displayName,
      });
      try {
        const sectionRecords = await getSectionPdfRecords(doc, tree, section, cache);
        for (const record of sectionRecords) {
          if (!recordsByObjectId.has(record.objectid)) {
            recordsByObjectId.set(record.objectid, record);
          }
        }
      } catch (error) {
        failures.push({ section, error });
        console.warn(`[${APP_NAME}] Failed to parse section`, section, error);
      } finally {
        completed += 1;
        progress({
          stage: "解析直链",
          current: completed,
          total: sections.length,
          detail: section.displayName,
        });
      }
    });

    await writeMetadataCache(tree.courseKey, cache);

    if (failures.length > 0) {
      showToast(doc, `${failures.length} 个小节解析失败，已保留成功解析的 PDF。`, "error", 5000);
    }

    return Array.from(recordsByObjectId.values()).sort(compareRecordPath);
  }

  async function getSectionPdfRecords(doc, tree, section, cache) {
    const cached = cache.sections[section.id];
    if (cached && cached.records && cached.records.length > 0 && Date.now() - cached.fetchedAt < METADATA_CACHE_TTL_MS) {
      return cached.records.map((record) => hydrateRecord(tree, section, record));
    }

    let objectIds = [];
    try {
      objectIds = await fetchSectionObjectIds(tree, section);
    } catch (error) {
      console.warn(`[${APP_NAME}] API extraction failed, trying live page fallback`, section, error);
    }

    if (objectIds.length === 0) {
      objectIds = await enqueueLiveExtraction(() => extractSectionObjectIdsViaLivePage(doc, tree, section));
    }

    const records = [];

    for (const objectId of objectIds) {
      let metadata = null;
      try {
        metadata = await fetchPdfMetadata(objectId);
      } catch (error) {
        console.warn(`[${APP_NAME}] Failed to read object metadata`, objectId, error);
      }
      if (!metadata || !metadata.pdf) continue;

      records.push(hydrateRecord(tree, section, {
        objectid: metadata.objectid || objectId,
        filename: metadata.filename || `${objectId}.pdf`,
        pdf: metadata.pdf,
        length: Number(metadata.length) || 0,
        pagenum: Number(metadata.pagenum) || 0,
      }));
    }

    if (records.length > 0) {
      cache.sections[section.id] = {
        fetchedAt: Date.now(),
        records: records.map(stripRecordForCache),
      };
    } else {
      delete cache.sections[section.id];
    }

    return records;
  }

  function hydrateRecord(tree, section, record) {
    const filename = ensurePdfExtension(sanitizeFileName(record.filename || `${record.objectid}.pdf`));
    const sectionDisplayName = section.displayName || section.title || section.id;
    const chapterDisplayName = section.chapterDisplayName || "未分组章节";

    return {
      ...record,
      filename,
      length: Number(record.length) || 0,
      courseName: tree.courseName,
      courseId: tree.courseId,
      clazzid: tree.clazzid,
      cpi: tree.cpi,
      sectionId: section.id,
      sectionLabel: section.label,
      sectionTitle: section.title,
      sectionDisplayName,
      chapterId: section.chapterId,
      chapterLabel: section.chapterLabel,
      chapterTitle: section.chapterTitle,
      chapterDisplayName,
      linkPath: `${chapterDisplayName} / ${sectionDisplayName} / ${filename}`,
      zipParts: [chapterDisplayName, sectionDisplayName, filename].map(sanitizeFileName),
    };
  }

  function stripRecordForCache(record) {
    return {
      objectid: record.objectid,
      filename: record.filename,
      pdf: record.pdf,
      length: record.length,
      pagenum: record.pagenum,
    };
  }

  async function fetchSectionObjectIds(tree, section) {
    const chapterHtml = await fetchChapterStudyHtml(tree, section);
    const chapterDoc = parseHtml(chapterHtml);
    const cardNums = extractCardNums(chapterDoc);

    const allObjectIds = new Set();
    await mapLimit(cardNums, METADATA_CONCURRENCY, async (num) => {
      const html = await fetchCardHtml(tree, section, num);
      for (const objectId of extractObjectIdsFromHtml(html)) {
        allObjectIds.add(objectId);
      }
    });

    if (allObjectIds.size === 0) {
      for (const objectId of extractObjectIdsFromHtml(chapterHtml)) {
        allObjectIds.add(objectId);
      }
    }

    return Array.from(allObjectIds);
  }

  function enqueueLiveExtraction(task) {
    const run = liveExtractionChain.then(task, task);
    liveExtractionChain = run.catch(() => {});
    return run;
  }

  async function extractSectionObjectIdsViaLivePage(doc, tree, section) {
    if (!doc || !doc.getElementById("coursetree")) return [];

    const win = doc.defaultView;
    const targetNode = doc.getElementById(`cur${section.id}`) || section.domNode;
    showToast(doc, `接口未直接解析到 ${section.displayName}，尝试打开章节抓取。`, "info", 2400);

    if (!isCurrentSectionActive(doc, section.id)) {
      if (win && typeof win.getTeacherAjax === "function") {
        win.getTeacherAjax(tree.courseId, tree.clazzid, section.id, tree.cpi || "0", "", "", "false");
      } else {
        const nameNode = targetNode?.querySelector(".posCatalog_name") || targetNode;
        if (!nameNode) return [];
        nameNode.dispatchEvent(new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: win,
        }));
      }
    }

    await waitFor(() => isCurrentSectionActive(doc, section.id), 12000);
    await waitFor(() => {
      const iframe = doc.getElementById("iframe");
      if (!iframe) return false;
      const src = iframe.getAttribute("src") || "";
      return src.includes(`knowledgeid=${section.id}`) || src.includes(`knowledgeid=${encodeURIComponent(section.id)}`);
    }, 12000).catch(() => {});
    await sleep(1200);

    const objectIds = extractObjectIdsFromLoadedDocument(doc);
    return objectIds;
  }

  function isCurrentSectionActive(doc, sectionId) {
    const chapterInput = doc.getElementById("chapterIdid") || doc.getElementById("chapterId") || doc.getElementById("curChapterId");
    if (chapterInput && String(chapterInput.value) === String(sectionId)) return true;
    return doc.getElementById(`cur${sectionId}`)?.classList.contains("posCatalog_active") || false;
  }

  function extractObjectIdsFromLoadedDocument(doc) {
    const objectIds = new Set(extractObjectIdsFromHtml(doc.documentElement?.outerHTML || ""));
    for (const iframe of Array.from(doc.querySelectorAll("iframe"))) {
      addObjectIdsFromText(objectIds, iframe.getAttribute("src") || "");
      addObjectIdsFromText(objectIds, iframe.getAttribute("data") || "");
      addObjectIdsFromText(objectIds, iframe.outerHTML || "");

      try {
        const childDoc = iframe.contentDocument;
        if (childDoc && childDoc.documentElement) {
          for (const objectId of extractObjectIdsFromLoadedDocument(childDoc)) {
            objectIds.add(objectId);
          }
        }
      } catch (_) {
        // Cross-origin iframe contents are not readable; attributes and network fallback still apply.
      }
    }
    return Array.from(objectIds);
  }

  async function fetchChapterStudyHtml(tree, section) {
    if (!tree.courseId || !tree.clazzid || !section.id) {
      throw new Error("缺少 courseId、clazzid 或 chapterId");
    }

    const url = new URL(`${getMoocAnsBase()}/mycourse/studentstudyAjax`);
    const params = {
      courseId: tree.courseId,
      clazzid: tree.clazzid,
      chapterId: section.id,
      cpi: tree.cpi || "0",
      verificationcode: "",
      mooc2: "1",
      toComputer: "false",
      microTopicId: "0",
      editorPreview: "0",
      isPreviewVideo: "false",
      videoWidth: "0",
      videoHeight: "0",
      targetVideoJobId: "",
      cardIndex: "0",
    };
    appendParams(url, params);
    return fetchText(url.toString());
  }

  async function fetchCardHtml(tree, section, num) {
    const url = new URL(`${getMoocAnsBase()}/knowledge/cards`);
    appendParams(url, {
      clazzid: tree.clazzid,
      courseid: tree.courseId,
      knowledgeid: section.id,
      num: String(num),
      ut: "s",
      cpi: tree.cpi || "0",
      mooc2: "1",
      isMicroCourse: "false",
      editorPreview: "0",
    });
    return fetchText(url.toString());
  }

  async function fetchPdfMetadata(objectId) {
    const url = `https://mooc1.chaoxing.com/ananas/status/${encodeURIComponent(objectId)}?flag=normal&_dc=${Date.now()}`;
    const text = await fetchAuthText(url, "application/json,text/plain,*/*");
    const data = JSON.parse(text);
    if (data.status && data.status !== "success") return null;
    if (!data.pdf || !/\.pdf(?:[?#]|$)/i.test(data.pdf)) return null;

    return {
      objectid: data.objectid || objectId,
      filename: data.filename || `${objectId}.pdf`,
      pdf: data.pdf,
      length: Number(data.length) || 0,
      pagenum: Number(data.pagenum) || 0,
    };
  }

  async function fetchText(url) {
    return fetchAuthText(url, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  }

  async function fetchAuthText(url, accept) {
    try {
      const response = await fetchWithTimeout(url, {
        credentials: "include",
        headers: {
          Accept: accept,
        },
      }, 45000);

      if (response.ok) {
        return response.text();
      }
    } catch (_) {
      // Cross-origin mooc1 requests from mooc2 pages may need the userscript fallback.
    }

    return gmFetchText(url, accept);
  }

  function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, {
      ...options,
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
  }

  function gmFetchText(url, accept) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(new Error("页面请求失败，且 GM_xmlhttpRequest 不可用。"));
        return;
      }

      GM_xmlhttpRequest({
        method: "GET",
        url,
        headers: {
          Accept: accept,
        },
        responseType: "text",
        timeout: 120000,
        onload(response) {
          if (response.status >= 200 && response.status < 300) {
            resolve(response.responseText || response.response || "");
          } else {
            reject(new Error(`请求失败 ${response.status}`));
          }
        },
        ontimeout() {
          reject(new Error("页面请求超时"));
        },
        onerror() {
          reject(new Error("页面请求失败"));
        },
      });
    });
  }

  function extractCardNums(doc) {
    const nums = new Set();

    for (const iframe of Array.from(doc.querySelectorAll("iframe[src*='knowledge/cards']"))) {
      const src = iframe.getAttribute("src") || "";
      const url = safeUrl(new URL(src, getMoocAnsBase()).toString());
      const num = url ? Number(url.searchParams.get("num")) : NaN;
      if (Number.isFinite(num)) nums.add(num);
    }

    const cardItems = Array.from(doc.querySelectorAll("#prev_tab li[cardid], .prev_ul li[cardid]"));
    for (const [index, item] of cardItems.entries()) {
      const onclick = item.getAttribute("onclick") || "";
      const match = onclick.match(/changeDisplayContent\s*\(\s*(\d+)/i);
      nums.add(match ? Number(match[1]) : index + 1);
    }

    if (nums.size > 0) return Array.from(nums).sort((a, b) => a - b);

    const count = Number(doc.querySelector("#cardcount")?.getAttribute("value") || "0");
    if (count > 0) {
      return Array.from({ length: count + 1 }, (_, index) => index);
    }

    return [0];
  }

  function extractObjectIdsFromHtml(html) {
    const objectIds = new Set();
    const doc = parseHtml(html);

    for (const iframe of Array.from(doc.querySelectorAll("iframe"))) {
      addObjectIdCandidate(objectIds, iframe.getAttribute("objectid"));
      addObjectIdCandidate(objectIds, iframe.getAttribute("objectId"));
      addObjectIdCandidate(objectIds, iframe.getAttribute("data-objectid"));
      addObjectIdCandidate(objectIds, iframe.getAttribute("mid"));
      addObjectIdsFromText(objectIds, iframe.getAttribute("src") || "");
      addObjectIdsFromText(objectIds, iframe.getAttribute("data") || "");
      addObjectIdsFromText(objectIds, iframe.getAttribute("name") || "");
      addObjectIdsFromText(objectIds, iframe.outerHTML || "");
    }

    addObjectIdsFromText(objectIds, html);
    addObjectIdsFromText(objectIds, tryDecode(html));

    return Array.from(objectIds);
  }

  function addObjectIdCandidate(set, value) {
    if (!value) return;
    const match = String(value).match(/^[a-f0-9]{32}$/i);
    if (match) set.add(match[0].toLowerCase());
  }

  function addObjectIdsFromText(set, text) {
    if (!text) return;
    const raw = String(text);
    const decoded = tryDecode(raw);
    const htmlDecoded = decodeHtmlEntities(raw);
    const samples = Array.from(new Set([raw, decoded, htmlDecoded, decodeHtmlEntities(decoded)]));
    const patterns = [
      /(?:objectid|objectId)["']?\s*[:=]\s*["']?([a-f0-9]{32})/gi,
      /(?:objectid|objectId)=([a-f0-9]{32})/gi,
      /\/(?:download|status)\/([a-f0-9]{32})/gi,
      /\/doc\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{2}\/([a-f0-9]{32})\//gi,
      /(?:objectid|objectId)[^a-f0-9]{1,32}([a-f0-9]{32})/gi,
    ];

    for (const sample of samples) {
      for (const pattern of patterns) {
        let match;
        pattern.lastIndex = 0;
        while ((match = pattern.exec(sample))) {
          set.add(match[1].toLowerCase());
        }
      }
    }
  }

  async function downloadZip(doc, tree, records, zipName, progress) {
    const entries = [];
    const usedPaths = new Set();
    let completed = 0;

    await mapLimit(records, ZIP_FETCH_CONCURRENCY, async (record) => {
      progress({
        stage: "下载 PDF",
        current: completed,
        total: records.length,
        detail: record.linkPath,
      });
      const arrayBuffer = await fetchPdfArrayBuffer(record.pdf);
      const zipPath = makeUniquePath(record.zipParts, usedPaths);
      entries.push({
        path: zipPath,
        data: new Uint8Array(arrayBuffer),
        date: new Date(),
      });
      completed += 1;
      progress({
        stage: "下载 PDF",
        current: completed,
        total: records.length,
        detail: record.linkPath,
      });
    });

    progress({
      stage: "压缩生成",
      current: 0,
      total: entries.length || 1,
      detail: "正在写入 ZIP 目录结构",
    });
    const zipBlob = await createStoredZipBlob(entries, (current, total, detail) => {
      progress({
        stage: "压缩生成",
        current,
        total,
        detail,
      });
    });

    triggerBlobDownload(doc, zipBlob, sanitizeFileName(zipName));
  }

  async function createStoredZipBlob(entries, onProgress) {
    if (!entries.length) {
      throw new Error("没有可写入 ZIP 的 PDF 文件。");
    }

    const files = [];
    let offset = 0;
    const now = new Date();

    for (const [index, entry] of entries.entries()) {
      await yieldToBrowser();
      const pathBytes = encodeUtf8(entry.path);
      const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
      const crc = crc32(data);
      const dos = toDosDateTime(entry.date || now);

      if (pathBytes.length > 0xffff) {
        throw new Error(`ZIP 路径过长：${entry.path}`);
      }
      if (data.length > 0xffffffff || offset > 0xffffffff) {
        throw new Error("文件过大，当前浏览器端 ZIP 写入器不支持 ZIP64。");
      }

      const localHeader = new Uint8Array(30 + pathBytes.length);
      const localView = new DataView(localHeader.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0x0800, true);
      localView.setUint16(8, 0, true);
      localView.setUint16(10, dos.time, true);
      localView.setUint16(12, dos.date, true);
      localView.setUint32(14, crc, true);
      localView.setUint32(18, data.length, true);
      localView.setUint32(22, data.length, true);
      localView.setUint16(26, pathBytes.length, true);
      localView.setUint16(28, 0, true);
      localHeader.set(pathBytes, 30);

      files.push({
        path: entry.path,
        pathBytes,
        data,
        crc,
        dos,
        localHeader,
        localOffset: offset,
      });

      offset += localHeader.length + data.length;
      onProgress(index + 1, entries.length, entry.path);
    }

    const centralParts = [];
    let centralSize = 0;
    for (const file of files) {
      const centralHeader = new Uint8Array(46 + file.pathBytes.length);
      const centralView = new DataView(centralHeader.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint16(12, file.dos.time, true);
      centralView.setUint16(14, file.dos.date, true);
      centralView.setUint32(16, file.crc, true);
      centralView.setUint32(20, file.data.length, true);
      centralView.setUint32(24, file.data.length, true);
      centralView.setUint16(28, file.pathBytes.length, true);
      centralView.setUint16(30, 0, true);
      centralView.setUint16(32, 0, true);
      centralView.setUint16(34, 0, true);
      centralView.setUint16(36, 0, true);
      centralView.setUint32(38, 0, true);
      centralView.setUint32(42, file.localOffset, true);
      centralHeader.set(file.pathBytes, 46);
      centralParts.push(centralHeader);
      centralSize += centralHeader.length;
    }

    const centralOffset = offset;
    const endHeader = new Uint8Array(22);
    const endView = new DataView(endHeader.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, files.length, true);
    endView.setUint16(10, files.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, centralOffset, true);
    endView.setUint16(20, 0, true);

    const parts = [];
    for (const file of files) {
      parts.push(file.localHeader, file.data);
    }
    parts.push(...centralParts, endHeader);

    onProgress(entries.length, entries.length, "ZIP 写入完成");
    return new Blob(parts, { type: "application/zip" });
  }

  function encodeUtf8(value) {
    return new TextEncoder().encode(String(value || ""));
  }

  function toDosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = Math.floor(date.getSeconds() / 2);
    return {
      date: ((year - 1980) << 9) | (month << 5) | day,
      time: (hours << 11) | (minutes << 5) | seconds,
    };
  }

  const crc32Table = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      }
      table[index] = value >>> 0;
    }
    return table;
  })();

  function crc32(data) {
    let crc = 0xffffffff;
    for (let index = 0; index < data.length; index += 1) {
      crc = crc32Table[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function yieldToBrowser() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function getZipRisk(records, totalBytes) {
    if (records.length > ZIP_MAX_FILE_COUNT) {
      return {
        blocked: true,
        reason: `PDF 数量 ${records.length} 个，超过浏览器端 ZIP 上限 ${ZIP_MAX_FILE_COUNT} 个`,
      };
    }

    if (totalBytes > 0 && totalBytes >= ZIP_THRESHOLD_BYTES) {
      return {
        blocked: true,
        reason: `预计总体积 ${formatBytes(totalBytes)}，超过浏览器端 ZIP 上限 ${formatBytes(ZIP_THRESHOLD_BYTES)}`,
      };
    }

    return { blocked: false, reason: "" };
  }

  async function fetchPdfArrayBuffer(url) {
    try {
      const response = await fetchWithTimeout(url, {
        credentials: "omit",
      }, 120000);
      if (response.ok) return await response.arrayBuffer();
    } catch (_) {
      // Fall back to Tampermonkey's cross-origin request below.
    }

    return gmFetchArrayBuffer(url);
  }

  function gmFetchArrayBuffer(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(new Error("PDF 跨域下载失败，且 GM_xmlhttpRequest 不可用。"));
        return;
      }

      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "arraybuffer",
        timeout: 120000,
        onload(response) {
          if (response.status >= 200 && response.status < 300 && response.response) {
            resolve(response.response);
          } else {
            reject(new Error(`PDF 下载失败 ${response.status}`));
          }
        },
        ontimeout() {
          reject(new Error("PDF 下载超时"));
        },
        onerror() {
          reject(new Error("PDF 下载请求失败"));
        },
      });
    });
  }

  async function fetchPdfBlob(url) {
    const arrayBuffer = await fetchPdfArrayBuffer(url);
    return new Blob([arrayBuffer], { type: "application/pdf" });
  }

  async function downloadDirectPdfs(doc, records, progress) {
    const usedNames = new Set();
    for (const [index, record] of records.entries()) {
      progress({
        stage: "下载 PDF",
        current: index,
        total: records.length,
        detail: record.linkPath,
      });
      const blob = await fetchPdfBlob(record.pdf);
      const filename = makeUniqueFileName(record.filename, usedNames);
      triggerBlobDownload(doc, blob, filename);
      progress({
        stage: "下载 PDF",
        current: index + 1,
        total: records.length,
        detail: record.linkPath,
      });
      if (index < records.length - 1) await sleep(DIRECT_DOWNLOAD_DELAY_MS);
    }
  }

  function makeUniqueFileName(filename, usedNames) {
    const safeName = sanitizeFileName(filename);
    const dotIndex = safeName.lastIndexOf(".");
    const base = dotIndex > 0 ? safeName.slice(0, dotIndex) : safeName;
    const ext = dotIndex > 0 ? safeName.slice(dotIndex) : "";
    let index = 0;
    let candidate = safeName;
    while (usedNames.has(candidate)) {
      index += 1;
      candidate = `${base} (${index + 1})${ext}`;
    }
    usedNames.add(candidate);
    return candidate;
  }

  function triggerBlobDownload(doc, blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = doc.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    doc.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      anchor.remove();
    }, 1000);
  }

  function renderOomModal(doc, options) {
    const old = doc.getElementById(`${APP}-oom-modal`);
    if (old) old.remove();

    const totalText = formatBytes(options.totalBytes);
    const backdrop = doc.createElement("div");
    backdrop.id = `${APP}-oom-modal`;
    backdrop.className = "cxpg-modal-backdrop";
    backdrop.innerHTML = `
      <div class="cxpg-modal" role="dialog" aria-modal="true" aria-labelledby="cxpg-modal-title">
        <button type="button" class="cxpg-modal-close" aria-label="关闭">×</button>
        <div class="cxpg-modal-header">
          <span class="cxpg-modal-icon" aria-hidden="true">!</span>
          <h2 class="cxpg-modal-title" id="cxpg-modal-title">压缩包体积较大</h2>
        </div>
        <div class="cxpg-modal-body">
          <div>当前范围内的 PDF 已超过默认安全阈值。继续生成 ZIP 可能导致当前标签页长时间无响应，甚至触发浏览器崩溃；通常不会影响账号数据，也不会改动本地已有文件。</div>
          <div class="cxpg-modal-size">预计总体积: ${escapeHtml(totalText)}</div>
          ${options.reason ? `<div class="cxpg-progress-detail">${escapeHtml(options.reason)}</div>` : ""}
        </div>
        <div class="cxpg-modal-footer">
          <button type="button" class="cxpg-btn cxpg-btn-secondary" data-action="cancel">暂不生成</button>
          <button type="button" class="cxpg-btn cxpg-btn-secondary" data-action="export">导出直链清单</button>
          <button type="button" class="cxpg-btn" data-action="force">仍然生成 ZIP</button>
        </div>
      </div>
    `;

    const close = () => backdrop.remove();
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close();
    });
    backdrop.querySelector(".cxpg-modal-close").addEventListener("click", close);
    backdrop.querySelector("[data-action='cancel']").addEventListener("click", close);
    backdrop.querySelector("[data-action='export']").addEventListener("click", () => {
      exportLinkList(doc, options.records, options.exportName || `${options.scopeName}课件直链清单.txt`);
      close();
    });
    backdrop.querySelector("[data-action='force']").addEventListener("click", () => {
      close();
      if (typeof options.onForceZip === "function") {
        options.onForceZip();
      }
    });

    doc.body.appendChild(backdrop);
  }

  function exportLinkList(doc, records, filename) {
    const totalBytes = records.reduce((sum, record) => sum + (Number(record.length) || 0), 0);
    const lines = [
      `${APP_NAME} 直链清单`,
      `生成时间: ${new Date().toLocaleString()}`,
      `文件数量: ${records.length}`,
      `预计总体积: ${formatBytes(totalBytes)}`,
      "",
      ...records.map((record) => `${record.linkPath} - ${record.pdf}`),
      "",
    ];
    const blob = new Blob([lines.join("\n")], {
      type: "text/plain;charset=utf-8",
    });
    triggerBlobDownload(doc, blob, sanitizeFileName(filename));
    showToast(doc, "直链清单已导出。", "success");
  }

  async function readMetadataCache(courseKey) {
    const key = getCacheKey(courseKey);
    const fallback = { version: CACHE_VERSION, courseKey, sections: {} };
    try {
      const value = typeof GM_getValue === "function" ? await GM_getValue(key) : localStorage.getItem(key);
      if (!value) return fallback;
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      if (!parsed || parsed.version !== CACHE_VERSION || parsed.courseKey !== courseKey) return fallback;
      parsed.sections = parsed.sections || {};
      return parsed;
    } catch (error) {
      console.warn(`[${APP_NAME}] Failed to read cache`, error);
      return fallback;
    }
  }

  async function writeMetadataCache(courseKey, cache) {
    const key = getCacheKey(courseKey);
    const payload = {
      version: CACHE_VERSION,
      courseKey,
      updatedAt: Date.now(),
      sections: cache.sections || {},
    };
    try {
      if (typeof GM_setValue === "function") {
        await GM_setValue(key, payload);
      } else {
        localStorage.setItem(key, JSON.stringify(payload));
      }
    } catch (error) {
      console.warn(`[${APP_NAME}] Failed to write cache`, error);
    }
  }

  function getCacheKey(courseKey) {
    return `${APP_NAME}:metadata:${courseKey}`;
  }

  function createProgressPanel(doc, title) {
    const old = doc.getElementById(`${APP}-progress`);
    if (old) old.remove();

    const panel = doc.createElement("div");
    panel.id = `${APP}-progress`;
    panel.className = "cxpg-progress";
    panel.innerHTML = `
      <div class="cxpg-progress-head">
        <div class="cxpg-progress-title">${escapeHtml(title)}</div>
        <button type="button" class="cxpg-progress-close" aria-label="隐藏进度">×</button>
      </div>
      <div class="cxpg-progress-status">
        <span data-role="stage">准备</span>
        <span data-role="count">0%</span>
      </div>
      <div class="cxpg-progress-track">
        <div class="cxpg-progress-bar" data-role="bar"></div>
      </div>
      <div class="cxpg-progress-detail" data-role="detail"></div>
    `;
    doc.body.appendChild(panel);

    const stageNode = panel.querySelector("[data-role='stage']");
    const countNode = panel.querySelector("[data-role='count']");
    const barNode = panel.querySelector("[data-role='bar']");
    const detailNode = panel.querySelector("[data-role='detail']");

    panel.querySelector(".cxpg-progress-close").addEventListener("click", () => panel.remove());

    return {
      update(state) {
        const total = Math.max(Number(state.total) || 0, 0);
        const current = Math.max(Number(state.current) || 0, 0);
        const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
        stageNode.textContent = state.stage || "处理中";
        countNode.textContent = total > 0 ? `${current}/${total}` : `${percent}%`;
        barNode.style.width = `${percent}%`;
        detailNode.textContent = state.detail || "";
      },
      close(delay = 0) {
        setTimeout(() => panel.remove(), delay);
      },
    };
  }

  function createProgressReporter(doc, button, panel) {
    let lastToastAt = 0;
    return (state) => {
      const normalized = typeof state === "string"
        ? { stage: state, current: 0, total: 0, detail: "" }
        : state;

      const label = normalized.total
        ? `${normalized.stage} ${normalized.current}/${normalized.total}`
        : normalized.stage;

      setButtonText(button, normalized.stage || "处理中");
      if (panel) panel.update(normalized);

      const now = Date.now();
      if (now - lastToastAt > 5000) {
        lastToastAt = now;
        showToast(doc, label, "info", 1800);
      }
    };
  }

  function setButtonBusy(button, text) {
    if (!button) return () => {};
    const oldText = button.textContent;
    const oldDisabled = button.disabled;
    button.disabled = true;
    button.classList.add("cxpg-busy");
    button.textContent = text;
    return () => {
      button.disabled = oldDisabled;
      button.classList.remove("cxpg-busy");
      button.textContent = oldText;
    };
  }

  function setButtonText(button, text) {
    if (button) button.textContent = text;
  }

  function showToast(doc, message, type = "info", timeout = 3500) {
    const ownerDoc = doc || document;
    let wrap = ownerDoc.getElementById(`${APP}-toast-wrap`);
    if (!wrap) {
      wrap = ownerDoc.createElement("div");
      wrap.id = `${APP}-toast-wrap`;
      wrap.className = "cxpg-toast-wrap";
      ownerDoc.body.appendChild(wrap);
    }

    const toast = ownerDoc.createElement("div");
    toast.className = `cxpg-toast cxpg-toast-${type}`;
    toast.textContent = message;
    wrap.appendChild(toast);
    setTimeout(() => toast.remove(), timeout);
  }

  function getMoocAnsBase() {
    if (/^mooc1\./i.test(location.hostname)) {
      return `${location.origin}/mooc-ans`;
    }
    return "https://mooc1.chaoxing.com/mooc-ans";
  }

  function appendParams(url, params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  function parseHtml(html) {
    return new DOMParser().parseFromString(html || "", "text/html");
  }

  function safeUrl(value) {
    try {
      return new URL(value);
    } catch (_) {
      return null;
    }
  }

  function isLikelyCourseDocument(doc) {
    const path = doc.defaultView?.location?.pathname || location.pathname;
    if (/studentcourse|studentstudy|mycourse|knowledge/i.test(path)) return true;
    return Boolean(
      doc.querySelector("a[href*='studentstudy'], [onclick*='getTeacherAjax'], [onclick*='chapterId']")
    );
  }

  function getLikelyRow(element) {
    return element.closest(
      "li, tr, .chapter_item, .chapter-item, .chapterUnit, .chapter-unit, .catalog_item, .catalog-item, .clearfix, .item"
    ) || element.parentElement;
  }

  function findGenericChapterTitle(doc, chapterKey, item) {
    if (chapterKey && item.rawText) {
      const lines = item.rawText.split(/\s{2,}|\n/).map(normalizeTitle).filter(Boolean);
      const exact = lines.find((line) => new RegExp(`^${escapeRegex(chapterKey)}\\s+`).test(line));
      if (exact) return stripLeadingLabel(exact);
    }

    const candidates = Array.from(doc.querySelectorAll("li, div, h1, h2, h3, h4"))
      .map((node) => ({
        node,
        text: cleanText(node.textContent || ""),
      }))
      .filter((entry) => entry.text && entry.text.length < 80);

    const match = candidates.find((entry) => {
      const label = extractSectionLabel(entry.text);
      return label === chapterKey;
    });

    return match ? stripLeadingLabel(match.text) : "";
  }

  function findGenericChapterNode(doc, chapterKey, sectionNode) {
    let node = sectionNode;
    while (node && node !== doc.body) {
      const text = cleanText(node.textContent || "");
      const label = extractSectionLabel(text);
      if (label === chapterKey) return node;
      node = node.parentElement;
    }
    return null;
  }

  function extractSectionLabel(text) {
    const match = cleanText(text).match(/(?:^|[^\d])(\d+(?:\.\d+)*)(?:\s|[^\d.]|$)/);
    return match ? match[1] : "";
  }

  function getChapterKey(label) {
    if (!label) return "";
    return String(label).split(".")[0];
  }

  function stripLeadingLabel(text) {
    return normalizeTitle(String(text || "")
      .replace(/^\s*\d+(?:\.\d+)*\s*/, "")
      .replace(/^(第\s*\d+\s*[章节]\s*)/, ""));
  }

  function normalizeTitle(value) {
    return cleanText(String(value || "")
      .replace(/\b(PDF|ZIP)\b/gi, "")
      .replace(/已完成|待完成任务点|暂无内容|展开|收起/g, ""));
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function composeDisplayName(label, title) {
    const normalizedTitle = normalizeTitle(title);
    if (label && normalizedTitle && !normalizedTitle.startsWith(label)) {
      return `${label} ${normalizedTitle}`;
    }
    return normalizedTitle || label || "未命名章节";
  }

  function sanitizeFileName(value) {
    const cleaned = String(value || "未命名")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "")
      .trim();
    return (cleaned || "未命名").slice(0, 120);
  }

  function ensurePdfExtension(filename) {
    return /\.pdf$/i.test(filename) ? filename : `${filename}.pdf`;
  }

  function makeUniquePath(parts, usedPaths) {
    const safeParts = parts.map(sanitizeFileName).filter(Boolean);
    const filename = safeParts.pop() || "未命名.pdf";
    const base = filename.replace(/\.pdf$/i, "");
    const ext = filename.match(/\.pdf$/i) ? ".pdf" : "";

    let index = 0;
    let candidate;
    do {
      const currentName = index === 0 ? filename : `${base} (${index + 1})${ext}`;
      candidate = [...safeParts, currentName].join("/");
      index += 1;
    } while (usedPaths.has(candidate));

    usedPaths.add(candidate);
    return candidate;
  }

  function formatBytes(bytes) {
    const size = Number(bytes) || 0;
    if (size >= 1024 * 1024 * 1024) {
      return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }
    return `${(size / 1024 / 1024).toFixed(2)} MB`;
  }

  function compareByLabel(a, b) {
    const left = parseLabelParts(a.label);
    const right = parseLabelParts(b.label);
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const delta = (left[index] || 0) - (right[index] || 0);
      if (delta !== 0) return delta;
    }
    return a.title.localeCompare(b.title, "zh-CN");
  }

  function compareRecordPath(a, b) {
    return a.linkPath.localeCompare(b.linkPath, "zh-CN");
  }

  function parseLabelParts(label) {
    return String(label || "")
      .split(".")
      .map((part) => Number(part) || 0);
  }

  async function mapLimit(items, limit, iterator) {
    const results = [];
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await iterator(items[currentIndex], currentIndex);
      }
    });
    await Promise.all(workers);
    return results;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(predicate, timeoutMs, intervalMs = 250) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (predicate()) return true;
      await sleep(intervalMs);
    }
    throw new Error("等待页面加载超时");
  }

  function tryDecode(value) {
    try {
      return decodeURIComponent(String(value));
    } catch (_) {
      return String(value || "");
    }
  }

  function decodeHtmlEntities(value) {
    const text = String(value || "");
    if (!/[&][a-zA-Z#0-9]+;/.test(text)) return text;
    const textarea = document.createElement("textarea");
    textarea.innerHTML = text;
    return textarea.value;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function getErrorMessage(error) {
    return error && error.message ? error.message : String(error || "未知错误");
  }
})();
