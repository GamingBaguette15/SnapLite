"use strict";

/**
 * SnapLite content script.
 *
 * Runs on supported practice sites (i-Ready, Khan Academy, Mathopolis — see
 * `content_scripts.matches` in manifest.json)
 * and adds a floating launcher in the bottom-left corner. Clicking it opens the
 * SnapLite panel above the button, which is the popup UI loaded in an iframe
 * so it keeps access to browser.tabs.captureVisibleTab and browser.storage.
 *
 * The UI is rendered inside a shadow root so i-Ready's styles cannot leak in and
 * SnapLite's styles cannot leak out.
 */

(() => {
  const HOST_ID = "snapgemini-floating-host";
  const SITES_KEY = "overlaySites";
  const DEFAULT_SITES = ["i-ready.com", "khanacademy.org", "mathopolis.com"];
  const ext = globalThis.browser || globalThis.chrome;
  const IS_TOP_FRAME = window.top === window;

  if (!ext || !ext.runtime || typeof ext.runtime.getURL !== "function") return;
  if (document.getElementById(HOST_ID)) return;

  const clampUnit = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.min(1, Math.max(0, number));
  };

  // Elements that can plausibly receive or select an answer. SnapLite numbers
  // them, the model replies with an id, and the bubble is anchored to the real
  // element — no pixel guessing, and it follows reflow and fullscreen exactly.
  const ANSWER_SELECTOR = [
    "input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset])",
    "textarea",
    "[contenteditable='true']",
    "[role='textbox']",
    "[role='radio']",
    "[role='checkbox']",
    "[role='option']",
    "[role='button']",
    "button",
    // i-Ready does not always use semantic controls for its choices.
    "[class*='answer']",
    "[class*='choice']",
    "[class*='response']",
  ].join(",");

  const liveTargets = new Map();
  const frameTargetBoxes = new Map();
  let targetSeq = 0;
  // Set once the top frame builds its UI; child frames never have one.
  let uiRoot = null;

  function targetLabel(el) {
    const raw =
      el.value ||
      el.innerText ||
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.title ||
      "";
    return String(raw).replace(/\s+/g, " ").trim().slice(0, 120);
  }

  function targetKind(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || el.isContentEditable) return "input";
    const role = el.getAttribute("role");
    if (role === "radio" || role === "checkbox" || role === "option") return "choice";
    return "button";
  }

  /** Text around the answer targets, so the model reads the question instead of OCR. */
  function questionScope(elements) {
    let node = elements.length ? elements[0].parentElement : null;
    for (const el of elements.slice(1)) {
      while (node && !node.contains(el)) node = node.parentElement;
      if (!node) break;
    }
    if (!node || node === document.body || node === document.documentElement) {
      return document.querySelector("main") || document.body;
    }
    return node;
  }

  function collectPageContext() {
    const targets = [];
    const elements = [];
    const seen = new Set();

    for (const el of document.querySelectorAll(ANSWER_SELECTOR)) {
      if (!el || (uiRoot && uiRoot.contains(el)) || el.disabled) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 6 || rect.height < 6) continue;
      if (rect.bottom < 2 || rect.right < 2) continue;
      if (rect.top > window.innerHeight - 2 || rect.left > window.innerWidth - 2) continue;
      // Skip page-sized wrappers that merely have "answer" in a class name.
      if (rect.width > window.innerWidth * 0.7 && rect.height > window.innerHeight * 0.7) {
        continue;
      }

      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") {
        continue;
      }

      const key = `${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const id = (targetSeq += 1);
      liveTargets.set(id, el);
      targets.push({
        id,
        kind: targetKind(el),
        text: targetLabel(el),
        rect: {
          x: rect.left,
          y: rect.top,
          w: rect.width,
          h: rect.height,
        },
      });
      elements.push(el);
      if (targets.length >= 40) break;
    }

    const scope = questionScope(elements);
    const questionText = String(scope.innerText || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1500);

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      questionText,
      targets,
    };
  }

  /** Child frames only answer context requests; they never build the launcher. */
  function handleFrameContextRequest(event) {
    const data = event.data;
    if (!data || data.source !== "snapgemini-frame" || data.type !== "context-request") return;

    collectTargetsWithRects()
      .then((context) => {
        if (!event.source) return;
        event.source.postMessage(
          { source: "snapgemini-frame", type: "context-result", id: data.id, context },
          "*"
        );
      })
      .catch(() => {
        if (!event.source) return;
        event.source.postMessage(
          { source: "snapgemini-frame", type: "context-result", id: data.id, context: null },
          "*"
        );
      });
  }

  /**
   * Ask every iframe on the page for its own context. i-Ready lessons render
   * inside a frame (often nested), so the top document alone usually lists no
   * answer targets. Child frames relay their own children, so nesting works.
   */
  function requestFrameContexts(timeoutMs) {
    const frames = Array.from(document.querySelectorAll("iframe")).map((frame) => ({
      frame,
      done: false,
    }));
    if (!frames.length) return Promise.resolve([]);

    const id = `ctx${(targetSeq += 1)}`;
    const results = [];

    return new Promise((resolve) => {
      let timer = 0;

      const finish = () => {
        window.removeEventListener("message", onReply);
        if (timer) window.clearTimeout(timer);
        resolve(results);
      };

      const maybeFinish = () => {
        if (frames.every((entry) => entry.done)) finish();
      };

      const onReply = (event) => {
        const data = event.data;
        if (!data || data.source !== "snapgemini-frame") return;
        if (data.type !== "context-result" || data.id !== id) return;

        const entry = frames.find((candidate) => candidate.frame.contentWindow === event.source);
        if (!entry || entry.done) return;
        entry.done = true;
        results.push({ frame: entry.frame, context: data.context });
        maybeFinish();
      };

      window.addEventListener("message", onReply);
      timer = window.setTimeout(finish, timeoutMs);

      for (const entry of frames) {
        try {
          entry.frame.contentWindow.postMessage(
            { source: "snapgemini-frame", type: "context-request", id },
            "*"
          );
        } catch (err) {
          entry.done = true;
        }
      }
      maybeFinish();
    });
  }

  /**
   * This frame's targets plus every descendant frame's, with all rects mapped
   * into this frame's viewport. Recursion is handled by each child replying with
   * its own merged result.
   */
  async function collectTargetsWithRects() {
    const base = collectPageContext();
    const frames = await requestFrameContexts(900);

    const targets = base.targets.slice();
    let questionText = base.questionText;

    for (const entry of frames) {
      const context = entry.context;
      if (!context || !Array.isArray(context.targets)) continue;

      const frameRect = entry.frame.getBoundingClientRect();
      const cw = (context.viewport && context.viewport.width) || frameRect.width;
      const ch = (context.viewport && context.viewport.height) || frameRect.height;
      if (!cw || !ch || frameRect.width < 4 || frameRect.height < 4) continue;

      const scaleX = frameRect.width / cw;
      const scaleY = frameRect.height / ch;

      for (const target of context.targets) {
        if (!target || !target.rect) continue;
        targets.push({
          id: target.id,
          kind: target.kind,
          text: target.text,
          rect: {
            x: frameRect.left + target.rect.x * scaleX,
            y: frameRect.top + target.rect.y * scaleY,
            w: target.rect.w * scaleX,
            h: target.rect.h * scaleY,
          },
        });
      }

      if (context.questionText && context.questionText.length > questionText.length) {
        questionText = context.questionText;
      }
    }

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      questionText,
      targets,
      localCount: base.targets.length,
    };
  }

  /**
   * Model-facing context: local targets keep their live element anchors, while
   * every iframe target is snapshotted as a normalized box (frames cannot be
   * measured live from the top document).
   */
  async function collectMergedContext() {
    const merged = await collectTargetsWithRects();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const targets = [];

    merged.targets.forEach((target, index) => {
      if (index < merged.localCount) {
        targets.push({ id: target.id, kind: target.kind, text: target.text });
        return;
      }

      const id = (targetSeq += 1);
      frameTargetBoxes.set(id, {
        x1: clampUnit(target.rect.x / vw),
        y1: clampUnit(target.rect.y / vh),
        x2: clampUnit((target.rect.x + target.rect.w) / vw),
        y2: clampUnit((target.rect.y + target.rect.h) / vh),
      });
      targets.push({ id, kind: target.kind, text: target.text });
    });

    return {
      viewport: merged.viewport,
      questionText: merged.questionText,
      targets,
      localCount: merged.localCount,
    };
  }

  if (!IS_TOP_FRAME) {
    window.addEventListener("message", handleFrameContextRequest);
    return;
  }

  const host = document.createElement("div");
  host.id = HOST_ID;
  // Hidden until the stored site list says this host is opted in.
  host.hidden = true;
  uiRoot = host;

  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host {
      all: initial;
    }

    .sg-wrap[hidden] {
      display: none;
    }

    .sg-wrap {
      position: fixed;
      left: 18px;
      bottom: 18px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 10px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      color-scheme: dark;
    }

    .sg-wrap.sg-hidden {
      display: none !important;
    }

    .sg-panel {
      width: min(392px, calc(100vw - 36px));
      height: min(612px, calc(100vh - 110px));
      background: #050607;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 16px;
      box-shadow: 0 18px 60px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.35);
      overflow: hidden;
      animation: sg-pop-in 0.16s ease-out;
    }

    .sg-panel[hidden] {
      display: none;
    }

    .sg-frame {
      display: block;
      width: 100%;
      height: 100%;
      border: 0;
      background: #050607;
    }

    .sg-fab {
      position: relative;
      display: grid;
      place-items: center;
      width: 54px;
      height: 54px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      cursor: pointer;
      color: #ffffff;
      background: linear-gradient(135deg, #22c55e 0%, #15803d 100%);
      box-shadow: 0 10px 26px rgba(34, 197, 94, 0.45), 0 2px 6px rgba(0, 0, 0, 0.35);
      transition: transform 0.16s ease, box-shadow 0.16s ease, filter 0.16s ease;
    }

    .sg-fab:hover {
      transform: translateY(-2px);
      filter: brightness(1.06);
      box-shadow: 0 14px 32px rgba(34, 197, 94, 0.55), 0 2px 6px rgba(0, 0, 0, 0.4);
    }

    .sg-fab:active {
      transform: scale(0.95);
    }

    .sg-fab:focus-visible {
      outline: 2px solid #86efac;
      outline-offset: 3px;
    }

    .sg-fab svg {
      width: 26px;
      height: 26px;
      display: block;
    }

    .sg-fab.is-open {
      background: #0b0f0c;
      color: #86efac;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
    }

    .sg-fab::after {
      content: "";
      position: absolute;
      inset: -6px;
      border-radius: 50%;
      border: 2px solid rgba(34, 197, 94, 0.55);
      opacity: 0;
      transition: opacity 0.2s ease;
      pointer-events: none;
    }

    .sg-fab:hover::after {
      opacity: 1;
    }

    /* Answer bubble anchored where the model says the answer belongs. */
    .sg-bubble {
      position: fixed;
      z-index: 2147483647;
      max-width: min(300px, calc(100vw - 24px));
      padding: 12px 34px 12px 14px;
      background: #0b0f0c;
      color: #e8f5ec;
      border: 1px solid #1e2b22;
      border-radius: 14px;
      box-shadow: 0 18px 44px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.35);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      animation: sg-bubble-in 0.16s ease-out;
    }

    .sg-bubble[hidden] {
      display: none;
    }

    .sg-bubble-text {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .sg-bubble-close {
      position: absolute;
      top: 4px;
      right: 5px;
      display: grid;
      place-items: center;
      width: 22px;
      height: 22px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: #8aa697;
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
    }

    .sg-bubble-close:hover {
      background: #101a13;
      color: #e8f5ec;
    }

    .sg-bubble-close:focus-visible {
      outline: 2px solid #86efac;
      outline-offset: 1px;
    }

    .sg-bubble-tail {
      position: absolute;
      left: var(--sg-tail-x, 28px);
      width: 14px;
      height: 14px;
      margin-left: -7px;
      background: #0b0f0c;
      transform: rotate(45deg);
    }

    .sg-bubble[data-tail="bottom"] .sg-bubble-tail {
      bottom: -8px;
      border-right: 1px solid #1e2b22;
      border-bottom: 1px solid #1e2b22;
    }

    .sg-bubble[data-tail="top"] .sg-bubble-tail {
      top: -8px;
      border-left: 1px solid #1e2b22;
      border-top: 1px solid #1e2b22;
    }

    .sg-bubble[data-tail="left"] .sg-bubble-tail {
      left: -8px;
      top: var(--sg-tail-y, 24px);
      margin-left: 0;
      margin-top: -7px;
      border-left: 1px solid #1e2b22;
      border-bottom: 1px solid #1e2b22;
    }

    .sg-bubble[data-tail="right"] .sg-bubble-tail {
      right: -8px;
      top: var(--sg-tail-y, 24px);
      margin-left: 0;
      margin-top: -7px;
      border-top: 1px solid #1e2b22;
      border-right: 1px solid #1e2b22;
    }

    .sg-bubble-layer {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      pointer-events: none;
    }

    .sg-bubble-layer[hidden] {
      display: none;
    }

    .sg-arrows {
      position: fixed;
      inset: 0;
      width: 100vw;
      height: 100vh;
      z-index: 2147483646;
      pointer-events: none;
      overflow: visible;
    }

    .sg-arrows line {
      stroke: #22c55e;
      stroke-width: 2;
      stroke-linecap: round;
      filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.55));
    }

    .sg-arrows polygon {
      fill: #22c55e;
      filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.55));
    }

    .sg-bubble {
      pointer-events: auto;
    }

    @keyframes sg-bubble-in {
      from {
        opacity: 0;
        transform: translateY(4px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    @keyframes sg-pop-in {
      from {
        opacity: 0;
        transform: translateY(8px) scale(0.98);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .sg-panel {
        animation: none;
      }
      .sg-fab {
        transition: none;
      }
    }
  `;

  const wrap = document.createElement("div");
  wrap.className = "sg-wrap";

  const panel = document.createElement("div");
  panel.className = "sg-panel";
  panel.hidden = true;

  const frame = document.createElement("iframe");
  frame.className = "sg-frame";
  frame.title = "SnapLite";
  frame.setAttribute("allow", "clipboard-write");
  frame.setAttribute("referrerpolicy", "no-referrer");
  panel.appendChild(frame);

  const fab = document.createElement("button");
  fab.type = "button";
  fab.className = "sg-fab";
  fab.title = "SnapLite — ask about this question";
  fab.setAttribute("aria-label", "Open SnapLite");
  fab.setAttribute("aria-expanded", "false");
  fab.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 2.5 15 9l6.5 3-6.5 3-3 6.5-3-6.5L2.5 12 9 9z" fill="currentColor" />
    </svg>
  `;

  const arrowSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrowSvg.setAttribute("class", "sg-arrows");
  arrowSvg.setAttribute("aria-hidden", "true");

  const bubbleLayer = document.createElement("div");
  bubbleLayer.className = "sg-bubble-layer";
  bubbleLayer.hidden = true;

  wrap.append(panel, fab);
  shadow.append(style, wrap, arrowSvg, bubbleLayer);
  document.documentElement.appendChild(host);

  function siteAllowed(hostname, list) {
    const host = String(hostname || "").toLowerCase();
    if (!host) return false;

    return list.some((entry) => {
      const site = String(entry || "")
        .toLowerCase()
        .replace(/^www\./, "");
      if (!site) return false;
      return host === site || host.endsWith(`.${site}`) || site.endsWith(`.${host}`);
    });
  }

  function setSiteEnabled(enabled) {
    host.hidden = !enabled;
    wrap.hidden = !enabled;
    if (!enabled) {
      closePanel();
      clearBubbles();
      setOverlayVisible(false);
    }
  }

  async function applyStoredSites() {
    let list = DEFAULT_SITES;
    try {
      const stored = await ext.storage.local.get(SITES_KEY);
      const value = stored && stored[SITES_KEY];
      if (Array.isArray(value)) list = value;
    } catch (err) {
      list = DEFAULT_SITES;
    }
    setSiteEnabled(siteAllowed(location.hostname, list));
  }

  // The toolbar popup writes this key, so the overlay appears or disappears
  // without needing a page reload.
  if (ext.storage && ext.storage.onChanged) {
    ext.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[SITES_KEY]) return;
      const value = changes[SITES_KEY].newValue;
      setSiteEnabled(siteAllowed(location.hostname, Array.isArray(value) ? value : DEFAULT_SITES));
    });
  }

  applyStoredSites();

  let loaded = false;

  function openPanel() {
    if (!loaded) {
      frame.src = ext.runtime.getURL("popup.html?embedded=1");
      loaded = true;
    }
    panel.hidden = false;
    fab.classList.add("is-open");
    fab.setAttribute("aria-expanded", "true");
  }

  function closePanel() {
    panel.hidden = true;
    fab.classList.remove("is-open");
    fab.setAttribute("aria-expanded", "false");
  }

  fab.addEventListener("click", () => {
    if (panel.hidden) openPanel();
    else closePanel();
  });

  /* ---------------------- answer bubbles + arrows ---------------------- */

  const SVG_NS = "http://www.w3.org/2000/svg";
  const MAX_BUBBLES = 4;

  function intersects(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  // Page-space annotations from the model, and the bubble element for each.
  let annotations = [];
  let bubbleEls = [];

  function setOverlayVisible(visible) {
    bubbleLayer.hidden = !visible;
    arrowSvg.style.display = visible ? "" : "none";
  }

  function drawArrow(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy);
    if (length < 6) return;

    const ux = dx / length;
    const uy = dy / length;
    const baseX = x2 - ux * 9;
    const baseY = y2 - uy * 9;

    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", x1.toFixed(1));
    line.setAttribute("y1", y1.toFixed(1));
    line.setAttribute("x2", baseX.toFixed(1));
    line.setAttribute("y2", baseY.toFixed(1));

    const head = document.createElementNS(SVG_NS, "polygon");
    const px = -uy * 5;
    const py = ux * 5;
    head.setAttribute(
      "points",
      [
        `${x2.toFixed(1)},${y2.toFixed(1)}`,
        `${(baseX + px).toFixed(1)},${(baseY + py).toFixed(1)}`,
        `${(baseX - px).toFixed(1)},${(baseY - py).toFixed(1)}`,
      ].join(" ")
    );

    arrowSvg.append(line, head);
  }

  function choosePlacement(target, width, height, vw, vh, occupied) {
    const margin = 12;
    const gap = 14;
    const cx = (target.left + target.right) / 2;
    const cy = (target.top + target.bottom) / 2;
    const clampX = (value) => Math.min(vw - width - margin, Math.max(margin, value));
    const clampY = (value) => Math.min(vh - height - margin, Math.max(margin, value));

    const candidates = [];
    if (target.top - gap - height >= margin) {
      candidates.push({ tail: "bottom", left: clampX(cx - width / 2), top: target.top - gap - height });
    }
    if (target.bottom + gap + height <= vh - margin) {
      candidates.push({ tail: "top", left: clampX(cx - width / 2), top: target.bottom + gap });
    }
    if (target.right + gap + width <= vw - margin) {
      candidates.push({ tail: "left", left: target.right + gap, top: clampY(cy - height / 2) });
    }
    if (target.left - gap - width >= margin) {
      candidates.push({ tail: "right", left: target.left - gap - width, top: clampY(cy - height / 2) });
    }

    const asRect = (candidate) => ({
      left: candidate.left,
      top: candidate.top,
      right: candidate.left + width,
      bottom: candidate.top + height,
    });
    const isFree = (candidate) => occupied.every((rect) => !intersects(asRect(candidate), rect));

    const free = candidates.find(isFree);
    if (free) return free;
    if (candidates.length) return candidates[0];

    const above = target.top - gap - height >= margin;
    return {
      tail: above ? "bottom" : "top",
      left: clampX(cx - width / 2),
      top: clampY(above ? target.top - gap - height : target.bottom + gap),
    };
  }

  function layoutAll() {
    if (!bubbleEls.length) return;

    arrowSvg.replaceChildren();

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const occupied = [];

    if (!wrap.classList.contains("sg-hidden")) {
      const panelRect = wrap.getBoundingClientRect();
      if (panelRect.width > 0 && panelRect.height > 0) occupied.push(panelRect);
    }

    bubbleEls.forEach((el, index) => {
      const annotation = annotations[index];
      if (!annotation) return;

      // A live DOM anchor is exact and survives reflow/fullscreen; otherwise fall
      // back to the normalized box, which is recomputed against the current
      // viewport so it moves with the window rather than staying put.
      let target = null;
      if (annotation.el && annotation.el.isConnected) {
        const rect = annotation.el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          target = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        }
      }
      if (!target && annotation.box) {
        target = {
          left: annotation.box.x1 * vw - window.scrollX,
          top: annotation.box.y1 * vh - window.scrollY,
          right: annotation.box.x2 * vw - window.scrollX,
          bottom: annotation.box.y2 * vh - window.scrollY,
        };
      }
      if (!target) {
        el.hidden = true;
        return;
      }

      if (target.right < 0 || target.bottom < 0 || target.left > vw || target.top > vh) {
        el.hidden = true;
        return;
      }

      // A zero-size box behaves like a point.
      if (target.right - target.left < 2) {
        target = { ...target, left: target.left - 1, right: target.right + 1 };
      }
      if (target.bottom - target.top < 2) {
        target = { ...target, top: target.top - 1, bottom: target.bottom + 1 };
      }

      el.hidden = false;
      el.style.visibility = "hidden";

      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const placement = choosePlacement(target, width, height, vw, vh, occupied);

      el.dataset.tail = placement.tail;
      el.style.top = `${Math.round(placement.top)}px`;
      el.style.left = `${Math.round(placement.left)}px`;
      el.style.removeProperty("--sg-tail-x");
      el.style.removeProperty("--sg-tail-y");

      const centerX = (target.left + target.right) / 2;
      const centerY = (target.top + target.bottom) / 2;
      let startX;
      let startY;

      if (placement.tail === "bottom" || placement.tail === "top") {
        const tailX = Math.min(width - 20, Math.max(20, centerX - placement.left));
        el.style.setProperty("--sg-tail-x", `${Math.round(tailX)}px`);
        startX = placement.left + tailX;
        startY = placement.tail === "bottom" ? placement.top + height + 6 : placement.top - 6;
      } else {
        const tailY = Math.min(height - 16, Math.max(16, centerY - placement.top));
        el.style.setProperty("--sg-tail-y", `${Math.round(tailY)}px`);
        startY = placement.top + tailY;
        startX = placement.tail === "left" ? placement.left - 6 : placement.left + width + 6;
      }

      // End the arrow on the nearest edge of the target box.
      const bubbleCenterX = placement.left + width / 2;
      const bubbleCenterY = placement.top + height / 2;
      const endX = Math.min(target.right, Math.max(target.left, bubbleCenterX));
      const endY = Math.min(target.bottom, Math.max(target.top, bubbleCenterY));

      drawArrow(startX, startY, endX, endY);

      occupied.push({
        left: placement.left,
        top: placement.top,
        right: placement.left + width,
        bottom: placement.top + height,
      });

      el.style.visibility = "visible";
    });
  }

  function removeBubble(index) {
    const el = bubbleEls[index];
    if (el) el.remove();
    bubbleEls.splice(index, 1);
    annotations.splice(index, 1);

    if (!bubbleEls.length) {
      setOverlayVisible(false);
      arrowSvg.replaceChildren();
      return;
    }
    layoutAll();
  }

  function createBubbleElement(text) {
    const el = document.createElement("div");
    el.className = "sg-bubble";

    const textEl = document.createElement("p");
    textEl.className = "sg-bubble-text";
    textEl.textContent = text;

    const close = document.createElement("button");
    close.type = "button";
    close.className = "sg-bubble-close";
    close.textContent = "\u00d7";
    close.setAttribute("aria-label", "Close this answer bubble");
    close.addEventListener("click", () => {
      // Look the element up again: earlier removals shift the indices.
      const index = bubbleEls.indexOf(el);
      if (index !== -1) removeBubble(index);
    });

    const tail = document.createElement("span");
    tail.className = "sg-bubble-tail";

    el.append(textEl, close, tail);
    return el;
  }

  function clearBubbles() {
    for (const el of bubbleEls) el.remove();
    bubbleEls = [];
    annotations = [];
    arrowSvg.replaceChildren();
    setOverlayVisible(false);
  }

  /**
   * @param {Array<{text: string, box: {x1:number,y1:number,x2:number,y2:number}}>} list
   */
  function showBubbles(list) {
    clearBubbles();

    for (const item of list.slice(0, MAX_BUBBLES)) {
      const text = String((item && item.text) || "").trim();
      const box = item && item.box;
      const targetId = Number(item && item.targetId);
      const anchored = targetId > 0 ? liveTargets.get(targetId) || null : null;
      const frameBox = targetId > 0 ? frameTargetBoxes.get(targetId) || null : null;
      if (!text || (!box && !anchored && !frameBox)) continue;

      annotations.push({
        text,
        el: anchored,
        box: frameBox
          ? { ...frameBox }
          : box
          ? {
              x1: clampUnit(box.x1),
              y1: clampUnit(box.y1),
              x2: clampUnit(box.x2),
              y2: clampUnit(box.y2),
            }
          : null,
      });

      const el = createBubbleElement(text);
      bubbleLayer.appendChild(el);
      bubbleEls.push(el);
    }

    console.debug(
      "SnapLite bubbles",
      annotations.map((item) => ({
        text: item.text,
        anchored: item.el ? String(item.el.innerText || item.el.value || "").slice(0, 40) : null,
        box: item.box,
      }))
    );

    if (!bubbleEls.length) {
      setOverlayVisible(false);
      return;
    }

    bubbleLayer.hidden = false;
    arrowSvg.style.display = "";
    layoutAll();
  }

  const relayout = () => {
    if (!annotations.length) return;
    // Two frames: Firefox reports the new viewport size after the mode change
    // has settled, and the bubble text may reflow at the new width.
    requestAnimationFrame(() => requestAnimationFrame(layoutAll));
  };

  window.addEventListener("resize", relayout);
  document.addEventListener("fullscreenchange", relayout);
  window.addEventListener("pageshow", relayout);
  window.addEventListener(
    "scroll",
    () => {
      if (annotations.length) layoutAll();
    },
    { passive: true }
  );

  function replyToFrame(payload) {
    try {
      frame.contentWindow.postMessage({ source: "snapgemini-host", ...payload }, "*");
    } catch (err) {
      // The frame may be gone.
    }
  }

  // The embedded popup asks for the overlay to disappear for a clean screenshot,
  // and for the grant tab to be opened (the frame lacks privileged APIs itself).
  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || data.source !== "snapgemini") return;

    if (data.type === "hide-ui") {
      wrap.classList.add("sg-hidden");
      setOverlayVisible(false);
    } else if (data.type === "show-ui") {
      wrap.classList.remove("sg-hidden");
      if (annotations.length) {
        setOverlayVisible(true);
        layoutAll();
      }
    } else if (data.type === "close") {
      closePanel();
    } else if (data.type === "show-bubbles") {
      const list = Array.isArray(data.annotations) ? data.annotations : [];
      showBubbles(
        list
          .map((item) => {
            const rawId = Number(item && item.targetId);
            const targetId = Number.isFinite(rawId) && rawId > 0 ? Math.round(rawId) : 0;

            const box = (item && item.box) || {};
            const values = ["x1", "y1", "x2", "y2"].map((key) => {
              const value = Number(box[key]);
              return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : Number.NaN;
            });
            const hasBox = values.every(Number.isFinite);
            if (!hasBox && !targetId) return null;

            const [x1, y1, x2, y2] = values;
            return {
              text: String((item && item.text) || ""),
              targetId,
              box: hasBox
                ? {
                    x1: Math.min(x1, x2),
                    y1: Math.min(y1, y2),
                    x2: Math.max(x1, x2),
                    y2: Math.max(y1, y2),
                  }
                : null,
            };
          })
          .filter(Boolean)
      );
    } else if (data.type === "hide-bubbles") {
      clearBubbles();
    } else if (data.type === "answer-context-request") {
      // Sent before a capture: the popup needs the live page text and the
      // numbered answer targets to drive the model and anchor the bubbles.
      collectMergedContext().then((context) =>
        replyToFrame({ type: "answer-context", context })
      );
    } else if (data.type === "capture-request") {
      ext.runtime
        .sendMessage({ type: "snapgemini:capture" })
        .then((response) =>
          replyToFrame({
            type: "capture-result",
            ok: Boolean(response && response.ok),
            dataUrl: response && response.dataUrl,
            error: response && response.error,
          })
        )
        .catch((err) =>
          replyToFrame({
            type: "capture-result",
            ok: false,
            error: err && err.message ? err.message : String(err),
          })
        );
    } else if (data.type === "open-grant") {
      ext.runtime
        .sendMessage({ type: "snapgemini:open-grant" })
        .then((response) => replyToFrame({ type: "grant-opened", ok: Boolean(response && response.ok) }))
        .catch(() => replyToFrame({ type: "grant-opened", ok: false }));
    }
  });

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && !panel.hidden) closePanel();
    },
    true
  );
})();
