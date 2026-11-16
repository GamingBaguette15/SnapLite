"use strict";

/**
 * SnapLite popup logic.
 *
 * Captures the visible tab, sends it together with the user's prompt to the
 * Gemini REST API and renders the answer. Works with both the `browser.*`
 * (promise based) and `chrome.*` (callback based) extension APIs.
 */

const STORAGE_KEY = "geminiApiKey";
const MODEL = "gemini-3.5-flash-lite";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const PROVIDER_KEY = "answerProvider";
const PROVIDERS = {
  gemini: {
    label: "Gemini",
    storageKey: STORAGE_KEY,
    placeholder: "AIza...",
    keyLabel: "Gemini API key",
    keyUrl: "https://aistudio.google.com/app/apikey",
  },
  nvidia: {
    label: "NVIDIA",
    storageKey: "nvidiaApiKey",
    placeholder: "nvapi-...",
    keyLabel: "NVIDIA API key",
    keyUrl: "https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b",
  },
};

const NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b";
let answerProvider = "gemini";

const SITES_KEY = "overlaySites";
const DEFAULT_SITES = ["i-ready.com", "khanacademy.org", "mathopolis.com"];
const DEFAULT_PROMPT = "What is the answer to the question on this page?";
const SYSTEM_INSTRUCTION =
  "You are SnapLite, built for online homework, quiz, and math practice pages. Read the " +
  "screenshot carefully: " +
  "identify the question, read every number, sign, exponent, fraction, and unit exactly as " +
  "shown, solve it, then re-check your arithmetic and the answer format before replying. " +
  "Reply with JSON only, shaped as {\"answer\": string, \"annotations\": [{\"text\": string, " +
  "\"target\": {\"x1\": number, \"y1\": number, \"x2\": number, \"y2\": number}}]}. " +
  "answer: the final answer only (never your reasoning), at most two sentences, plain text " +
  "with no markdown, LaTeX, or dollar signs; a bare number, expression, or phrase is ideal, " +
  "and for multiple choice give the correct option's text. " +
  "annotations: one to three short callouts drawn over the screenshot. Use one callout " +
  "normally; use two or three only when the question has separate parts or several blanks, " +
  "one callout per blank, each pointing at its own answer field. Each text is a few words " +
  "or a bare value. Each target is the tight bounding box, normalized 0 to 1 from the " +
  "top-left of the screenshot, around the exact field where that answer is entered (answer " +
  "box, blank gap, answer line, or the choice to select). Hug the field's visible edges and " +
  "exclude the question text, labels, and buttons; x1/y1 is the top-left corner and x2/y2 " +
  "the bottom-right. The callouts and arrows are drawn exactly at those coordinates, so be " +
  "precise. " +
  "When the page's own text is supplied with the request, trust it over the screenshot " +
  "for the question and the answer choices, because OCR can misread signs, exponents, " +
  "and units. When a list of numbered answer targets from the page DOM is supplied, set " +
  "targetId to the id of the exact target where the answer belongs (for multiple choice, " +
  "the option that has to be selected) and still return coordinates as a backup; use " +
  "targetId 0 only when no listed target matches. " +
  "A separate locator refines your coordinates afterwards, so your target is only a first " +
  "guess: give your best box, keep every coordinate between 0.02 and 0.98, and aim at the " +
  "centre of the largest obvious answer field or answer choice. If you truly cannot locate " +
  "an answer field, return an empty annotations array instead of guessing. " +
  "Before replying, check the result a second way: substitute your answer back into the " +
  "problem and confirm it satisfies every condition, and for word problems define the " +
  "variables and re-solve the equations. " +
  "Only give a longer answer if the user explicitly asks for detail.";

const ANSWER_SCHEMA = {
  type: "OBJECT",
  properties: {
    answer: {
      type: "STRING",
      description:
        "The final answer only, at most two sentences, plain text with no markdown or LaTeX.",
    },
    annotations: {
      type: "ARRAY",
      description:
        "One callout normally; two or three when a question has separate parts or blanks.",
      items: {
        type: "OBJECT",
        properties: {
          text: {
            type: "STRING",
            description: "A few words or a bare value for this callout.",
          },
          targetId: {
            type: "INTEGER",
            description:
              "Id of the answer target from the supplied page list, or 0 when none matches.",
          },
          target: {
            type: "OBJECT",
            description:
              "Tight bounding box, normalized 0-1 from the screenshot's top-left, around the " +
              "field where this answer is entered.",
            properties: {
              x1: { type: "NUMBER", description: "Left edge (0-1)." },
              y1: { type: "NUMBER", description: "Top edge (0-1)." },
              x2: { type: "NUMBER", description: "Right edge (0-1)." },
              y2: { type: "NUMBER", description: "Bottom edge (0-1)." },
            },
            required: ["x1", "y1", "x2", "y2"],
          },
        },
        required: ["text", "target"],
      },
    },
  },
  required: ["answer", "annotations"],
};


const CAPTURE_OPTIONS = { format: "png" };
const CAPTURE_MIME = "image/png";
const DECISIONS_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/decisions";
const LOCATOR_MODEL = "gemini-decision-1";
const CAPTURE_HIDE_DELAY = 180;
const EMBEDDED = window.top !== window;
let grantTabOpened = false;
const MAX_SENTENCES = 2;
const DETAIL_PATTERN =
  /\b(in detail|detailed|step[- ]by[- ]step|walk me through|list (?:all|every|the)|full (?:explanation|solution)|explain fully)\b/i;

const ext = typeof browser !== "undefined" ? browser : typeof chrome !== "undefined" ? chrome : null;

const els = {
  settingsToggle: document.getElementById("settingsToggle"),
  settingsPanel: document.getElementById("settingsPanel"),
  apiKey: document.getElementById("apiKey"),
  keyLabel: document.getElementById("keyLabel"),
  providerButtons: Array.from(document.querySelectorAll(".provider")),
  revealKey: document.getElementById("revealKey"),
  saveKey: document.getElementById("saveKey"),
  keyStatus: document.getElementById("keyStatus"),
  keyLink: document.getElementById("keyLink"),
  prompt: document.getElementById("prompt"),
  capture: document.getElementById("capture"),
  clear: document.getElementById("clear"),
  status: document.getElementById("status"),
  statusText: document.getElementById("statusText"),
  error: document.getElementById("error"),
  response: document.getElementById("response"),
  copy: document.getElementById("copy"),
  closePanel: document.getElementById("closePanel"),
  permissionBanner: document.getElementById("permissionBanner"),
  grantAccess: document.getElementById("grantAccess"),
  siteRow: document.getElementById("siteRow"),
  siteHost: document.getElementById("siteHost"),
  siteToggle: document.getElementById("siteToggle"),
};

const IDLE_RESPONSE =
  "No answer yet. Capture a question to get started.";

/**
 * Ask the i-Ready launcher to hide/show the overlay so it never appears in the
 * screenshot. No-op when the popup is opened from the toolbar.
 * @param {"hide-ui"|"show-ui"|"close"} type
 */
function postToHost(type, payload) {
  if (!EMBEDDED) return;
  try {
    window.parent.postMessage({ source: "snapgemini", type, ...(payload || {}) }, "*");
  } catch (err) {
    // The host page may be gone; nothing else to do.
  }
}

/* ------------------------------------------------------------------------- */
/* Storage helpers                                                           */
/* ------------------------------------------------------------------------- */

function storageArea() {
  return ext && ext.storage && ext.storage.local ? ext.storage.local : null;
}

/**
 * Read a single key from storage. Uses the promise form when available and
 * falls back to the callback form (Chrome) otherwise.
 * @param {string} key
 * @returns {Promise<string>}
 */
function storageGet(key) {
  const area = storageArea();
  if (!area) {
    return Promise.reject(new Error("Extension storage is unavailable."));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    try {
      const maybePromise = area.get(key);
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(
          (items) => finish(resolve, (items && items[key]) || ""),
          (err) => finish(reject, err instanceof Error ? err : new Error(String(err)))
        );
        return;
      }
    } catch (err) {
      // Fall through to the callback form below.
    }

    try {
      area.get(key, (items) => {
        const runtimeError = ext.runtime && ext.runtime.lastError;
        if (runtimeError) {
          finish(reject, new Error(runtimeError.message || "Failed to read storage."));
          return;
        }
        finish(resolve, (items && items[key]) || "");
      });
    } catch (err) {
      finish(reject, err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Write a single key to storage, preferring the promise form.
 * @param {string} key
 * @param {string} value
 * @returns {Promise<void>}
 */
function storageSet(key, value) {
  const area = storageArea();
  if (!area) {
    return Promise.reject(new Error("Extension storage is unavailable."));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    try {
      const maybePromise = area.set({ [key]: value });
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(
          () => finish(resolve),
          (err) => finish(reject, err instanceof Error ? err : new Error(String(err)))
        );
        return;
      }
    } catch (err) {
      // Fall through to the callback form below.
    }

    try {
      area.set({ [key]: value }, () => {
        const runtimeError = ext.runtime && ext.runtime.lastError;
        if (runtimeError) {
          finish(reject, new Error(runtimeError.message || "Failed to save storage."));
          return;
        }
        finish(resolve);
      });
    } catch (err) {
      finish(reject, err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/* ------------------------------------------------------------------------- */
/* UI helpers                                                                */
/* ------------------------------------------------------------------------- */

function setStatus(message, spinning = true) {
  if (!message) {
    els.status.hidden = true;
    els.statusText.textContent = "";
    return;
  }
  els.status.classList.toggle("no-spinner", !spinning);
  els.statusText.textContent = message;
  els.status.hidden = false;
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

function clearError() {
  els.error.textContent = "";
  els.error.hidden = true;
}

function setBusy(busy) {
  els.capture.disabled = busy;
  els.saveKey.disabled = busy;
  els.apiKey.disabled = busy;
  els.prompt.disabled = busy;
}

function setResponse(text) {
  els.response.textContent = text;
  els.copy.disabled = !text || text === IDLE_RESPONSE;
}

function setKeyStatus(message, isSuccess) {
  els.keyStatus.textContent = message;
  els.keyStatus.classList.toggle("success", Boolean(isSuccess));
}

function readKeyFromInput() {
  return els.apiKey.value.trim();
}

function openSettings() {
  els.settingsPanel.hidden = false;
  els.settingsToggle.setAttribute("aria-expanded", "true");
  els.apiKey.focus();
}

/**
 * Firefox only allows tabs.captureVisibleTab with the `<all_urls>` permission or
 * a granted activeTab. The in-page panel has neither, so ask for `<all_urls>`
 * from the click that starts the capture (the request needs a user gesture).
 * The toolbar popup is skipped: opening it already grants activeTab.
 * @returns {Promise<boolean>} whether capture is allowed
 */
/**
 * Ask the launcher (content script) to have the background page open the grant
 * tab, then wait for its confirmation. The panel's iframe has a restricted API
 * surface, so messaging goes through the content script instead of `runtime`.
 * @returns {Promise<boolean>} whether the grant tab opened
 */
function openGrantPage() {
  return new Promise((resolve) => {
    if (!EMBEDDED) {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onReply);
      resolve(value);
    };

    const onReply = (event) => {
      const data = event.data;
      if (!data || data.source !== "snapgemini-host" || data.type !== "grant-opened") return;
      finish(Boolean(data.ok));
    };

    window.addEventListener("message", onReply);
    postToHost("open-grant");
    window.setTimeout(() => finish(false), 1500);
  });
}

async function ensureKeySaved(provider) {
  const config = PROVIDERS[provider] || PROVIDERS.gemini;
  const typed = readKeyFromInput();
  if (!typed) {
    throw new Error(
      `Add your ${config.label} API key first. Open “API key” above and save it — it stays on this device.`
    );
  }

  const stored = await storageGet(config.storageKey);
  if (stored !== typed) {
    await storageSet(config.storageKey, typed);
    setKeyStatus("Saved", true);
  }
  return typed;
}

/* ------------------------------------------------------------------------- */
/* Capture + API                                                             */
/* ------------------------------------------------------------------------- */

function captureVisibleTab() {
  if (!ext || !ext.tabs || typeof ext.tabs.captureVisibleTab !== "function") {
    return Promise.reject(new Error("This browser does not support tab capture for extensions."));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const describe = (message) => {
      const text = String(message || "");
      if (/cannot access|cannot capture|permission|denied/i.test(text)) {
        return new Error(
          "Firefox blocked the screenshot of this tab. Try a regular http(s) page, or reload the add-on after granting access."
        );
      }
      return new Error(text || "Could not capture the current tab.");
    };

    try {
      const maybePromise = ext.tabs.captureVisibleTab(null, CAPTURE_OPTIONS);
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(
          (dataUrl) => finish(resolve, dataUrl),
          (err) => finish(reject, describe(err && err.message))
        );
        return;
      }
    } catch (err) {
      finish(reject, describe(err && err.message));
      return;
    }

    try {
      ext.tabs.captureVisibleTab(null, CAPTURE_OPTIONS, (dataUrl) => {
        const runtimeError = ext.runtime && ext.runtime.lastError;
        if (runtimeError) {
          finish(reject, describe(runtimeError.message));
          return;
        }
        finish(resolve, dataUrl);
      });
    } catch (err) {
      finish(reject, describe(err && err.message));
    }
  });
}

/** Ask the background page to capture the tab (works from embedded iframes). */
function sendCaptureRequest() {
  return new Promise((resolve, reject) => {
    if (!ext || !ext.runtime || typeof ext.runtime.sendMessage !== "function") {
      reject(new Error("SnapLite's background script is unavailable. Reload the add-on."));
      return;
    }

    const handle = (response) => {
      if (response && response.ok === true && response.dataUrl) {
        resolve(response.dataUrl);
        return;
      }

      const raw = (response && response.error) || "";
      if (/activeTab|permission|denied|access/i.test(raw)) {
        reject(
          new Error(
            "Firefox blocked screen capture. Allow SnapLite's screen-access request, " +
              "or enable “Access your data for all websites” for SnapLite in about:addons."
          )
        );
        return;
      }

      reject(new Error(raw || "Could not capture the current tab."));
    };

    try {
      const maybePromise = ext.runtime.sendMessage({ type: "snapgemini:capture" });
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(handle, (err) =>
          reject(err instanceof Error ? err : new Error(String(err)))
        );
        return;
      }
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    try {
      ext.runtime.sendMessage({ type: "snapgemini:capture" }, (response) => {
        const runtimeError = ext.runtime && ext.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || "Could not capture the current tab."));
          return;
        }
        handle(response);
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Capture the visible tab. Firefox blocks `tabs.captureVisibleTab` for extension
 * pages embedded in a web page, so the i-Ready launcher always goes through the
 * background page; the toolbar popup can call the API directly.
 * @returns {Promise<string>} data URL
 */
/**
 * Ask the launcher to capture through the background page. The panel's frame has
 * a restricted API surface, so the request travels over postMessage: the content
 * script relays it to the background and returns the data URL.
 * @returns {Promise<string>} data URL of the screenshot
 */
/**
 * Ask the i-Ready launcher for the live page text and its numbered answer
 * targets, so the model can read the real question instead of OCR and the
 * bubbles can anchor to real elements. Resolves null outside the panel.
 * @returns {Promise<{questionText?: string, targets?: Array, viewport?: object}|null>}
 */
function requestPageContext() {
  if (!EMBEDDED) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    let timer = 0;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onReply);
      if (timer) window.clearTimeout(timer);
      resolve(value);
    };

    const onReply = (event) => {
      const data = event.data;
      if (!data || data.source !== "snapgemini-host" || data.type !== "answer-context") return;
      finish(data.context && typeof data.context === "object" ? data.context : null);
    };

    window.addEventListener("message", onReply);
    timer = window.setTimeout(() => finish(null), 2000);
    postToHost("answer-context-request");
  });
}

/**
 * Render the DOM context as extra text for the model. Returns "" when the
 * toolbar popup has no page access, so requests stay unchanged there.
 */
function describePageContext(context) {
  if (!context) return "";

  const lines = [];
  const question = typeof context.questionText === "string" ? context.questionText.trim() : "";
  if (question) {
    lines.push(`Question area text read from the page DOM: "${question.slice(0, 1500)}"`);
  }

  const targets = Array.isArray(context.targets) ? context.targets : [];
  if (targets.length) {
    const list = targets
      .slice(0, 40)
      .map((target) => {
        const text = String((target && target.text) || "").replace(/\s+/g, " ").slice(0, 120);
        return `#${target.id} ${target.kind}: "${text}"`;
      })
      .join(" | ");
    lines.push(`Numbered answer targets on the page: ${list}`);
  }

  return lines.join("\n");
}

function requestCaptureFromHost() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onReply);
      fn(value);
    };

    const onReply = (event) => {
      const data = event.data;
      if (!data || data.source !== "snapgemini-host" || data.type !== "capture-result") return;
      if (data.ok && data.dataUrl) {
        finish(resolve, data.dataUrl);
      } else {
        finish(reject, new Error(data.error || "Could not capture the current tab."));
      }
    };

    window.addEventListener("message", onReply);
    postToHost("capture-request");
    window.setTimeout(
      () => finish(reject, new Error("Firefox did not return a screenshot. Reload the add-on and the page, then retry.")),
      25000
    );
  });
}

async function captureTabDataUrl() {
  if (EMBEDDED) {
    return requestCaptureFromHost();
  }

  if (ext && ext.tabs && typeof ext.tabs.captureVisibleTab === "function") {
    try {
      return await captureVisibleTab();
    } catch (err) {
      // Fall through to the background page below.
    }
  }

  return sendCaptureRequest();
}

function stripDataUrlPrefix(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl) {
    throw new Error("The screenshot came back empty.");
  }
  const marker = "base64,";
  const index = dataUrl.indexOf(marker);
  if (index === -1) {
    throw new Error("The screenshot was not returned as base64 data.");
  }
  return dataUrl.slice(index + marker.length);
}

/**
 * Capture the visible tab at full native resolution (lossless PNG). When the
 * popup is embedded in the i-Ready launcher, the overlay is hidden first so the
 * SnapLite panel is not part of the screenshot.
 * @returns {Promise<string>} base64 JPEG/PNG payload without the data URL prefix
 */
async function captureScreen() {
  if (EMBEDDED) {
    postToHost("hide-ui");
    await new Promise((resolve) => window.setTimeout(resolve, CAPTURE_HIDE_DELAY));
  }

  try {
    return await captureTabDataUrl();
  } finally {
    if (EMBEDDED) postToHost("show-ui");
  }
}

function percent(value) {
  return Math.round(value * 1000) / 10;
}

/**
 * Ask Gemini Decision 1 a batch of yes/no questions about a grid laid over the
 * screenshot, and return the cell that most likely holds the answer field.
 *
 * @param {string} apiKey
 * @param {string} base64Image clean PNG (no grid drawn on it)
 * @param {{x1:number,y1:number,x2:number,y2:number}} windowBox normalized area to search
 * @param {number} cols
 * @param {number} rows
 * @param {string} fieldLabel what to find, e.g. `answer field for "2 tens"`
 * @returns {Promise<{box: object, probability: number}|null>}
 */
async function decisionGrid(apiKey, base64Image, windowBox, cols, rows, fieldLabel) {
  const questions = {};

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x1 = windowBox.x1 + ((windowBox.x2 - windowBox.x1) * col) / cols;
      const x2 = windowBox.x1 + ((windowBox.x2 - windowBox.x1) * (col + 1)) / cols;
      const y1 = windowBox.y1 + ((windowBox.y2 - windowBox.y1) * row) / rows;
      const y2 = windowBox.y1 + ((windowBox.y2 - windowBox.y1) * (row + 1)) / rows;

      questions[`r${row}c${col}`] = {
        type: "noul",
        instructions:
          `Consider only the rectangle from ${percent(x1)}% to ${percent(x2)}% of the image ` +
          `width, and ${percent(y1)}% to ${percent(y2)}% of the image height. Is the ` +
          `${fieldLabel} (the box, blank, input line, or answer choice where this answer is ` +
          `entered or selected) centred inside that rectangle?`,
        criteria: {
          true_description: "The centre of the answer field lies inside the rectangle.",
          false_description:
            "The answer field is outside the rectangle, or the rectangle only shows question " +
            "text, labels, buttons, or empty page.",
        },
      };
    }
  }

  const response = await fetch(DECISIONS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      model: LOCATOR_MODEL,
      input: [
        { type: "text", text: "Screenshot of a homework or quiz page." },
        { type: "image", data: base64Image, mime_type: CAPTURE_MIME, resolution: "ultra_high" },
      ],
      questions,
    }),
  });

  if (!response.ok) {
    throw new Error(`Decision locator failed with status ${response.status}.`);
  }

  const payload = await response.json();
  const answers = (payload && payload.answers) || {};

  const cellWidth = (windowBox.x2 - windowBox.x1) / cols;
  const cellHeight = (windowBox.y2 - windowBox.y1) / rows;
  const cellBox = (row, col) => ({
    x1: clamp01(windowBox.x1 + col * cellWidth),
    y1: clamp01(windowBox.y1 + row * cellHeight),
    x2: clamp01(windowBox.x1 + (col + 1) * cellWidth),
    y2: clamp01(windowBox.y1 + (row + 1) * cellHeight),
  });

  const cells = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const answer = answers[`r${row}c${col}`];
      const probability = answer && typeof answer.noul === "number" ? answer.noul : 0;
      cells.push({ probability, row, col });
    }
  }
  if (!cells.length) return null;

  cells.sort((a, b) => b.probability - a.probability);
  const best = cells[0];

  // A field that straddles cell boundaries lights up several cells, so take the
  // union of the confident ones — unless that union is so large it stops
  // pointing at anything, in which case the single best cell is sharper.
  const strong = cells.filter((cell) => cell.probability >= 0.4);
  const chosen = strong.length > 1 ? strong : [best];
  const colStart = Math.min(...chosen.map((cell) => cell.col));
  const colEnd = Math.max(...chosen.map((cell) => cell.col));
  const rowStart = Math.min(...chosen.map((cell) => cell.row));
  const rowEnd = Math.max(...chosen.map((cell) => cell.row));

  let box = {
    x1: clamp01(windowBox.x1 + colStart * cellWidth),
    y1: clamp01(windowBox.y1 + rowStart * cellHeight),
    x2: clamp01(windowBox.x1 + (colEnd + 1) * cellWidth),
    y2: clamp01(windowBox.y1 + (rowEnd + 1) * cellHeight),
  };
  if (box.x2 - box.x1 > 0.4 || box.y2 - box.y1 > 0.4) {
    box = cellBox(best.row, best.col);
  }

  return { probability: best.probability, box };
}

/**
 * Two-pass localization: a coarse 10x6 sweep of the whole screenshot, then a
 * 6x5 sweep inside the winning cell.
 * @returns {Promise<{x1:number,y1:number,x2:number,y2:number}|null>}
 */
async function locateTarget(apiKey, base64Image, label) {
  const cleaned = label.replace(/\s+/g, " ").trim().slice(0, 60) || "the answer";
  const fieldLabel = `answer field for "${cleaned}"`;

  const coarse = await decisionGrid(
    apiKey,
    base64Image,
    { x1: 0, y1: 0, x2: 1, y2: 1 },
    10,
    6,
    fieldLabel
  );
  if (!coarse || coarse.probability < 0.5) return null;

  const padX = (coarse.box.x2 - coarse.box.x1) * 0.75;
  const padY = (coarse.box.y2 - coarse.box.y1) * 0.75;
  const windowBox = {
    x1: clamp01(coarse.box.x1 - padX),
    y1: clamp01(coarse.box.y1 - padY),
    x2: clamp01(coarse.box.x2 + padX),
    y2: clamp01(coarse.box.y2 + padY),
  };

  const fine = await decisionGrid(apiKey, base64Image, windowBox, 6, 5, fieldLabel);
  if (!fine || fine.probability < 0.5) return coarse.box;

  // Third zoom on the surviving cell: brings the box down to ~1-2% of the page.
  const padX2 = (fine.box.x2 - fine.box.x1) * 0.4;
  const padY2 = (fine.box.y2 - fine.box.y1) * 0.4;
  const narrow = {
    x1: clamp01(fine.box.x1 - padX2),
    y1: clamp01(fine.box.y1 - padY2),
    x2: clamp01(fine.box.x2 + padX2),
    y2: clamp01(fine.box.y2 + padY2),
  };
  const closer = await decisionGrid(apiKey, base64Image, narrow, 5, 5, fieldLabel);
  return closer && closer.probability >= 0.45 ? closer.box : fine.box;
}

/**
 * Replace the text model's guessed coordinates with located ones. Falls back to
 * the model's own box (then to no bubble) whenever the locator is unsure.
 */
function normalizeForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, " ")
    .replace(/[.,;:!?]+$/g, "")
    .trim();
}

/**
 * Match an answer against the page's own target labels. An exact unique match
 * ("2 tens" vs the "2 tens" choice) is the most reliable anchor available and
 * needs no model call at all.
 * @returns {number} target id, or 0 when nothing matches uniquely
 */
function matchTargetId(text, targets) {
  const needle = normalizeForMatch(text);
  if (!needle || !Array.isArray(targets) || !targets.length) return 0;

  const hits = targets.filter((target) => {
    const label = normalizeForMatch(target && target.text);
    if (!label) return false;
    return label === needle || label.includes(needle) || needle.includes(label);
  });

  return hits.length === 1 ? hits[0].id : 0;
}

/**
 * When the answer text does not match a label exactly, let Decision 1 pick
 * between the page's own targets as a closed-set choice. That is far stronger
 * than pixel coordinates, and the chosen id is anchored to a real element.
 * @returns {Promise<number>} target id, or 0 when unsure
 */
async function pickTargetWithDecisions(apiKey, base64Image, text, targets) {
  const usable = (Array.isArray(targets) ? targets : [])
    .filter((target) => target && target.id && String(target.text || "").trim())
    .slice(0, 40);
  if (usable.length < 2) return 0;

  const answer = String(text || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const criteria = {};
  for (const target of usable) {
    criteria[`t${target.id}`] = `${target.kind}: ${String(target.text)
      .replace(/\s+/g, " ")
      .slice(0, 100)}`;
  }

  const response = await fetch(DECISIONS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      model: LOCATOR_MODEL,
      input: [
        { type: "text", text: `Student answer that has to be placed: "${answer}"` },
        { type: "image", data: base64Image, mime_type: CAPTURE_MIME, resolution: "high" },
      ],
      questions: {
        target: {
          type: "choice",
          instructions:
            "Which numbered answer target is where this student answer belongs (the input " +
            "box, blank, or the choice that has to be selected)?",
          criteria,
        },
      },
    }),
  });

  if (!response.ok) return 0;

  const payload = await response.json();
  const reply = payload && payload.answers && payload.answers.target;
  if (!reply || typeof reply.confidence !== "number" || reply.confidence < 0.5) return 0;

  const match = /^t(\d+)$/.exec(String(reply.choice || ""));
  return match ? Number(match[1]) : 0;
}

async function locateAnnotations(apiKey, base64Image, result, pageContext) {
  const sources = result.annotations.length
    ? result.annotations.map((item) => ({
        text: item.text,
        box: item.box,
        targetId: item.targetId,
      }))
    : [{ text: result.answer, box: null, targetId: 0 }];

  const located = await Promise.all(
    sources.slice(0, 3).map(async (source) => {
      const text = String(source.text || "").trim();
      if (!text) return null;

      // A DOM anchor is exact: the content script measures the real element, so
      // skip the pixel locator entirely.
      if (source.targetId) {
        console.debug("SnapLite anchor: model targetId", source.targetId);
        return { text, targetId: source.targetId, box: source.box || null };
      }

      // The answer often matches an on-page choice verbatim; anchor to it.
      const matched = matchTargetId(text, pageContext && pageContext.targets);
      if (matched) {
        console.debug("SnapLite anchor: label match", matched);
        return { text, targetId: matched, box: source.box || null };
      }

      // Otherwise ask Decision 1 to pick among the page's own targets.
      if (apiKey) {
        let picked = 0;
        try {
          picked = await pickTargetWithDecisions(
            apiKey,
            base64Image,
            text,
            pageContext && pageContext.targets
          );
        } catch (err) {
          picked = 0;
        }
        if (picked) {
          console.debug("SnapLite anchor: decision choice", picked);
          return { text, targetId: picked, box: source.box || null };
        }
      }

      console.debug("SnapLite anchor: falling back to pixels for", text);
      let box = null;
      if (apiKey) {
        try {
          box = await locateTarget(apiKey, base64Image, text);
        } catch (err) {
          box = null;
        }
      }

      const chosen = box || source.box;
      console.debug("SnapLite anchor: box", chosen ? JSON.stringify(chosen) : "none");
      return chosen ? { text, box: chosen } : null;
    })
  );

  return located.filter(Boolean);
}

/* ------------------------------------------------------------------------- */
/* Answer shaping                                                            */
/* ------------------------------------------------------------------------- */

/** Remove LaTeX/plain-math delimiters so the answer reads cleanly. */
function stripMathDelimiters(text) {
  return text
    .replace(/\$\$([\s\S]+?)\$\$/g, "$1")
    .replace(/\$([^$\n]+?)\$/g, "$1")
    .replace(/\\\[([\s\S]+?)\\\]/g, "$1")
    .replace(/\\\(([\s\S]+?)\\\)/g, "$1");
}

function splitSentences(text) {
  try {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
      return Array.from(segmenter.segment(text), (item) => item.segment);
    }
  } catch (err) {
    // Fall through to the regex splitter.
  }
  return text.split(/(?<=[.!?])\s+/);
}

/**
 * Keep answers short: two sentences at most, unless the prompt explicitly asks
 * for detail. Purely formatting, so it also guards against a chatty model.
 */
function formatAnswer(text, prompt) {
  const cleaned = stripMathDelimiters(text).replace(/[ \t]{2,}/g, " ").trim();
  if (!cleaned || DETAIL_PATTERN.test(prompt || "")) {
    return cleaned;
  }

  const sentences = splitSentences(cleaned)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  if (sentences.length <= MAX_SENTENCES) {
    return cleaned;
  }
  return sentences.slice(0, MAX_SENTENCES).join(" ").trim();
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/**
 * Validate and normalize the model's target box. Corners are clamped to 0-1 and
 * reordered so x1/y1 is always the top-left, whatever order the model used.
 * @returns {{x1:number,y1:number,x2:number,y2:number}|null}
 */
function normalizeTargetBox(target) {
  if (!target || typeof target !== "object") return null;

  const values = ["x1", "y1", "x2", "y2"].map((key) =>
    typeof target[key] === "number" ? clamp01(target[key]) : Number.NaN
  );
  if (!values.every(Number.isFinite)) return null;

  const [ax, ay, bx, by] = values;
  return {
    x1: Math.min(ax, bx),
    y1: Math.min(ay, by),
    x2: Math.max(ax, bx),
    y2: Math.max(ay, by),
  };
}

/**
 * Validate the model's callouts: drop entries with no usable box, clamp their
 * text, and cap the count so the page cannot be flooded with bubbles.
 * @param {unknown} list
 * @returns {Array<{text: string, box: {x1:number,y1:number,x2:number,y2:number}}>}
 */
function normalizeAnnotations(list) {
  if (!Array.isArray(list)) return [];

  const seen = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;

    const rawId = Number(item.targetId);
    const targetId = Number.isFinite(rawId) && rawId > 0 ? Math.round(rawId) : 0;

    let box = normalizeTargetBox(item.target);
    if (box) {
      // Reject boxes that cannot be a real field: the whole screenshot, or a
      // zero-size point jammed into a corner (a common hallucination).
      const boxWidth = box.x2 - box.x1;
      const boxHeight = box.y2 - box.y1;
      const nearCorner =
        (box.x1 < 0.03 || box.x2 > 0.97) && (box.y1 < 0.03 || box.y2 > 0.97);
      if (boxWidth * boxHeight > 0.85 || (boxWidth < 0.01 && boxHeight < 0.01 && nearCorner)) {
        box = null;
      }
    }
    if (!box && !targetId) continue;

    const text = formatAnswer(typeof item.text === "string" ? item.text : "", "").slice(0, 200);
    if (!text) continue;

    // Skip near-duplicate targets (the model sometimes repeats one field).
    const duplicate = seen.some((entry) => {
      if (targetId && entry.targetId === targetId) return true;
      if (!box || !entry.box) return false;
      return (
        Math.abs(entry.box.x1 - box.x1) < 0.02 &&
        Math.abs(entry.box.y1 - box.y1) < 0.02 &&
        Math.abs(entry.box.x2 - box.x2) < 0.02 &&
        Math.abs(entry.box.y2 - box.y2) < 0.02
      );
    });
    if (duplicate) continue;

    seen.push({ text, box, targetId });
    if (seen.length === 4) break;
  }

  return seen;
}

/**
 * Turn the model's JSON reply into `{ answer, x, y }`. Falls back to treating the
 * whole reply as the answer when the JSON is missing or malformed, so a chatty
 * or truncated response still shows something useful (just without a bubble).
 * @param {string} text raw model output
 * @param {string} prompt the user's prompt (used for the length cap rules)
 */
function parseAnswerPayload(text, prompt) {
  const raw = String(text || "").trim();
  const unfenced = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let payload = null;
  try {
    payload = JSON.parse(unfenced);
  } catch (err) {
    const match = unfenced.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        payload = JSON.parse(match[0]);
      } catch (innerErr) {
        payload = null;
      }
    }
  }

  if (payload && typeof payload.answer === "string") {
    return {
      answer: formatAnswer(payload.answer, prompt),
      annotations: normalizeAnnotations(payload.annotations),
    };
  }

  return { answer: formatAnswer(unfenced, prompt), annotations: [] };
}

function describeHttpError(status, payload) {
  const apiMessage =
    payload && payload.error && typeof payload.error.message === "string"
      ? payload.error.message.trim()
      : "";

  let hint;
  if (status === 400) {
    hint =
      "The request was rejected. Check that your API key is valid and the prompt is not empty.";
  } else if (status === 401) {
    hint = "Your API key was not accepted. Re-enter it under “API key”.";
  } else if (status === 403) {
    hint =
      "Access denied. Confirm the Gemini API is enabled for your key and that the key has no restrictions blocking this add-on.";
  } else if (status === 404) {
    hint = "The Gemini model could not be found. The extension may need updating.";
  } else if (status === 429) {
    hint = "You have hit the Gemini rate limit or your free-tier quota. Wait a moment and try again.";
  } else if (status >= 500) {
    hint = "Google's Gemini service had a problem. Please try again in a few seconds.";
  } else {
    hint = `Gemini returned an unexpected status (${status}).`;
  }

  return apiMessage ? `${hint}\n\nDetails: ${apiMessage}` : hint;
}

async function askGemini(apiKey, prompt, base64Image, pageContext) {
  const contextText = describePageContext(pageContext);

  const body = {
    systemInstruction: {
      parts: [{ text: SYSTEM_INSTRUCTION }],
    },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: ANSWER_SCHEMA,
      temperature: 0.2,
    },
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          ...(contextText ? [{ text: contextText }] : []),
          { inline_data: { mime_type: CAPTURE_MIME, data: base64Image } },
        ],
      },
    ],
  };

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      "Could not reach Google Gemini. Check your internet connection and try again." +
        (err && err.message ? `\n\nDetails: ${err.message}` : "")
    );
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (err) {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(describeHttpError(response.status, payload));
  }

  const candidate =
    payload && Array.isArray(payload.candidates) ? payload.candidates[0] : null;
  const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
    ? candidate.content.parts
    : [];
  const text = parts
    .filter((part) => part && part.thought !== true)
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();

  if (text) {
    return parseAnswerPayload(text, prompt);
  }

  const blockReason =
    payload && payload.promptFeedback && payload.promptFeedback.blockReason
      ? String(payload.promptFeedback.blockReason)
      : candidate && candidate.finishReason
        ? String(candidate.finishReason)
        : "";

  if (blockReason) {
    throw new Error(
      `Gemini returned no text (finish reason: ${blockReason}). Try a different prompt or page.`
    );
  }

  throw new Error("Gemini returned an empty response. Try capturing the tab again.");
}

/* ------------------------------------------------------------------------- */
/* NVIDIA NIM (OpenAI-compatible, streaming)                                  */
/* ------------------------------------------------------------------------- */

function describeNvidiaError(status, payload) {
  const detail =
    payload && payload.error && typeof payload.error.message === "string"
      ? payload.error.message.trim()
      : payload && typeof payload.detail === "string"
        ? payload.detail.trim()
        : "";

  let hint;
  if (status === 400) {
    hint = "NVIDIA rejected the request. Check the prompt and try again.";
  } else if (status === 401) {
    hint = "Your NVIDIA API key was not accepted. Re-enter it under “API key”.";
  } else if (status === 402) {
    hint = "This NVIDIA key has no credits left for that endpoint.";
  } else if (status === 403) {
    hint = "Access denied for this NVIDIA model. Confirm the key is allowed to call it.";
  } else if (status === 404) {
    hint = "The NVIDIA model could not be found. SnapLite may need updating.";
  } else if (status === 429) {
    hint = "You have hit the NVIDIA rate limit. Wait a moment and try again.";
  } else if (status >= 500) {
    hint = "NVIDIA's inference service had a problem. Please try again in a few seconds.";
  } else {
    hint = `NVIDIA returned an unexpected status (${status}).`;
  }

  return detail ? `${hint}\n\nDetails: ${detail}` : hint;
}

/**
 * Read an OpenAI-style SSE stream and concatenate the delta text. The NVIDIA
 * model is used with `stream: true`, so the answer arrives in chunks.
 * @returns {Promise<string>}
 */
async function readStreamText(response) {
  if (!response.body || typeof response.body.getReader !== "function") return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  const consume = (line) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const payload = JSON.parse(data);
      const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
      const delta = choice && (choice.delta || choice.message);
      if (delta && typeof delta.content === "string") text += delta.content;
    } catch (err) {
      // Keep-alive or a split chunk boundary; nothing to add.
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let index = buffer.indexOf("\n");
    while (index !== -1) {
      consume(buffer.slice(0, index).trim());
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  }

  if (buffer.trim()) consume(buffer.trim());
  return text;
}

async function askNvidia(apiKey, prompt, base64Image, pageContext) {
  const contextText = describePageContext(pageContext);
  const userText = contextText ? `${prompt}\n\n${contextText}` : prompt;

  const body = {
    model: NVIDIA_MODEL,
    messages: [
      { role: "system", content: SYSTEM_INSTRUCTION },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: `data:${CAPTURE_MIME};base64,${base64Image}` } },
        ],
      },
    ],
    temperature: 0.2,
    top_p: 0.9,
    // Reasoning is left on: Nemotron's math accuracy collapses without it, and
    // the reasoning stream is separate from the final content we parse.
    max_tokens: 8192,
    // This model is only served on the streaming path.
    stream: true,
    chat_template_kwargs: { enable_thinking: true },
  };

  let response;
  try {
    response = await fetch(NVIDIA_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      "Could not reach the NVIDIA API. Check your internet connection and try again." +
        (err && err.message ? `\n\nDetails: ${err.message}` : "")
    );
  }

  const contentType = String(response.headers.get("content-type") || "");

  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch (err) {
      payload = null;
    }
    throw new Error(describeNvidiaError(response.status, payload));
  }

  let text = "";
  if (contentType.includes("application/json")) {
    // Some gateways answer a stream request with a single JSON document.
    let payload = null;
    try {
      payload = await response.json();
    } catch (err) {
      payload = null;
    }
    const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
    if (choice && choice.message && typeof choice.message.content === "string") {
      text = choice.message.content;
    }
  } else {
    text = await readStreamText(response);
  }

  text = text.trim();
  if (!text) {
    throw new Error("NVIDIA returned an empty response. Try capturing the tab again.");
  }

  return parseAnswerPayload(text, prompt);
}

async function askModel(provider, apiKey, prompt, base64Image, pageContext) {
  return provider === "nvidia"
    ? askNvidia(apiKey, prompt, base64Image, pageContext)
    : askGemini(apiKey, prompt, base64Image, pageContext);
}

/* ------------------------------------------------------------------------- */
/* Main flow                                                                 */
/* ------------------------------------------------------------------------- */

async function runCapture() {
  if (els.capture.disabled) return;

  clearError();
  setBusy(true);

  try {
    setKeyStatus("", false);
    const provider = answerProvider;
    const apiKey = await ensureKeySaved(provider);
    const prompt = els.prompt.value.trim() || DEFAULT_PROMPT;

    setStatus("Capturing...");
    // Drop the previous answer bubble; a new one only appears with a new answer.
    postToHost("hide-bubbles");
    const pageContext = await requestPageContext();
    const screenshot = await captureScreen();
    const base64Image = stripDataUrlPrefix(screenshot);

    setStatus("Thinking...");
    const result = await askModel(provider, apiKey, prompt, base64Image, pageContext);

    setResponse(result.answer);
    setStatus("");

    if (!EMBEDDED) {
      postToHost("hide-bubbles");
      return;
    }

    setStatus("Pointing...");
    // The Decisions locator belongs to Gemini. In NVIDIA mode use a saved Gemini
    // key if one exists; otherwise anchoring relies on DOM targets alone.
    let locatorKey = "";
    if (provider === "gemini") {
      locatorKey = apiKey;
    } else {
      try {
        locatorKey = (await storageGet(STORAGE_KEY)) || "";
      } catch (err) {
        locatorKey = "";
      }
    }
    const annotations = await locateAnnotations(locatorKey, base64Image, result, pageContext);
    setStatus("");

    if (annotations.length) {
      postToHost("show-bubbles", { annotations });
    } else {
      postToHost("hide-bubbles");
    }
  } catch (err) {
    setResponse(IDLE_RESPONSE);
    setStatus("");

    const message = err && err.message ? err.message : "Something went wrong. Please try again.";
    showError(message);

    if (err && /API key/i.test(String(err.message || ""))) {
      openSettings();
    }

    // Screen access is missing: open the top-level grant tab once, since Firefox
    // cannot prompt from inside this panel.
    if (EMBEDDED && !grantTabOpened && /activeTab|permission|screen access/i.test(message)) {
      grantTabOpened = true;
      const opened = await openGrantPage();
      if (opened) {
        showError(
          message +
            "\n\nA SnapLite tab was opened — click “Allow screen capture” there, then press " +
            "Capture & Answer again."
        );
      }
    }
  } finally {
    setBusy(false);
    els.capture.focus();
  }
}

async function copyResponse() {
  const text = els.response.textContent || "";
  if (!text || text === IDLE_RESPONSE) return;

  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
    } else {
      const scratch = document.createElement("textarea");
      scratch.value = text;
      scratch.setAttribute("readonly", "");
      scratch.style.position = "fixed";
      scratch.style.opacity = "0";
      document.body.appendChild(scratch);
      scratch.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(scratch);
      if (!copied) throw new Error("copy rejected");
    }
    const previous = els.copy.textContent;
    els.copy.textContent = "Copied!";
    els.copy.disabled = true;
    window.setTimeout(() => {
      els.copy.textContent = previous || "Copy Response";
      els.copy.disabled = false;
    }, 1400);
  } catch (err) {
    showError("Copying failed. Select the text in the response box and copy it manually.");
  }
}

/* ------------------------------------------------------------------------- */
/* Wiring                                                                    */
/* ------------------------------------------------------------------------- */

function showPermissionBanner(show) {
  if (!els.permissionBanner) return;
  els.permissionBanner.hidden = !show;
}

async function refreshPermissionBanner() {
  if (EMBEDDED || !ext || !ext.permissions || typeof ext.permissions.contains !== "function") {
    return;
  }
  try {
    const granted = await ext.permissions.contains({ origins: ["<all_urls>"] });
    showPermissionBanner(!granted);
  } catch (err) {
    showPermissionBanner(false);
  }
}

/* ------------------------------------------------------------------------- */
/* Per-site overlay opt-in                                                   */
/* ------------------------------------------------------------------------- */

function siteBase(hostname) {
  return String(hostname || "")
    .toLowerCase()
    .replace(/^www\./, "");
}

/** A stored site covers its own host and any subdomain of it. */
function siteMatches(hostname, list) {
  const host = String(hostname || "").toLowerCase();
  if (!host || !Array.isArray(list)) return false;

  return list.some((entry) => {
    const site = siteBase(entry);
    if (!site) return false;
    return host === site || host.endsWith(`.${site}`) || site.endsWith(`.${host}`);
  });
}

/** Sites the overlay is allowed on; unknown storage falls back to the defaults. */
async function loadSites() {
  try {
    const stored = await storageGet(SITES_KEY);
    return Array.isArray(stored) ? stored.map(siteBase) : DEFAULT_SITES.slice();
  } catch (err) {
    return DEFAULT_SITES.slice();
  }
}

function urlHost(url) {
  try {
    return new URL(url).hostname;
  } catch (err) {
    return "";
  }
}

/** Hostname of the tab the popup was opened on. Resolves "" when unavailable. */
function activeTabHost() {
  return new Promise((resolve) => {
    if (!ext || !ext.tabs || typeof ext.tabs.query !== "function") {
      resolve("");
      return;
    }

    try {
      const maybePromise = ext.tabs.query({ active: true, currentWindow: true });
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(
          (tabs) => resolve(urlHost(tabs && tabs[0] && tabs[0].url)),
          () => resolve("")
        );
        return;
      }
    } catch (err) {
      // Fall through to the callback form.
    }

    try {
      ext.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(urlHost(tabs && tabs[0] && tabs[0].url));
      });
    } catch (err) {
      resolve("");
    }
  });
}

async function refreshSiteToggle() {
  if (!els.siteRow || EMBEDDED) return;

  const host = await activeTabHost();
  if (!host) {
    els.siteRow.hidden = true;
    return;
  }

  const sites = await loadSites();
  const enabled = siteMatches(host, sites);

  els.siteRow.hidden = false;
  els.siteToggle.hidden = false;
  els.siteHost.textContent = host;
  els.siteToggle.textContent = enabled ? "Remove" : "Add";
  els.siteToggle.dataset.enabled = enabled ? "1" : "0";
  els.siteToggle.title = enabled
    ? `Remove the SnapLite overlay from ${host}`
    : `Add the SnapLite overlay to ${host}`;
}

/**
 * Switch the answer model. Each provider keeps its own saved key, so the input
 * is reloaded rather than shared.
 */
function applyProvider(provider, options = {}) {
  answerProvider = PROVIDERS[provider] ? provider : "gemini";
  const config = PROVIDERS[answerProvider];

  for (const button of els.providerButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.provider === answerProvider));
  }

  if (els.keyLabel) els.keyLabel.textContent = config.keyLabel;
  if (els.apiKey) els.apiKey.placeholder = config.placeholder;
  if (els.keyLink) els.keyLink.href = config.keyUrl;

  if (options.persist) {
    storageSet(PROVIDER_KEY, answerProvider).catch(() => {
      /* Ignore: the toggle still works for this session. */
    });
  }
  if (options.resetInput && els.apiKey) els.apiKey.value = "";
}

async function init() {
  if (EMBEDDED) {
    document.documentElement.classList.add("embedded");
    if (els.closePanel) els.closePanel.hidden = false;
    if (els.siteRow) els.siteRow.hidden = true;
  }

  refreshPermissionBanner();
  refreshSiteToggle();

  if (!ext) {
    showError("SnapLite must be loaded as a browser extension.");
    els.capture.disabled = true;
    return;
  }

  try {
    const storedProvider = await storageGet(PROVIDER_KEY);
    if (storedProvider === "gemini" || storedProvider === "nvidia") {
      answerProvider = storedProvider;
    }
  } catch (err) {
    answerProvider = "gemini";
  }

  applyProvider(answerProvider);

  try {
    const savedKey = await storageGet(PROVIDERS[answerProvider].storageKey);
    if (savedKey) {
      els.apiKey.value = savedKey;
      setKeyStatus("Key loaded", true);
    } else {
      openSettings();
    }
  } catch (err) {
    showError("Could not read the saved API key from this browser's storage.");
  }
}

els.settingsToggle.addEventListener("click", () => {
  const willOpen = els.settingsPanel.hidden;
  els.settingsPanel.hidden = !willOpen;
  els.settingsToggle.setAttribute("aria-expanded", String(willOpen));
  if (willOpen) els.apiKey.focus();
});

els.revealKey.addEventListener("click", () => {
  const showing = els.apiKey.type === "text";
  els.apiKey.type = showing ? "password" : "text";
  els.revealKey.textContent = showing ? "Show" : "Hide";
  els.revealKey.setAttribute("aria-label", showing ? "Show API key" : "Hide API key");
  els.apiKey.focus();
});

els.saveKey.addEventListener("click", async () => {
  clearError();
  const typed = readKeyFromInput();
  if (!typed) {
    setKeyStatus("Enter a key first", false);
    els.apiKey.focus();
    return;
  }

  try {
    await storageSet(PROVIDERS[answerProvider].storageKey, typed);
    setKeyStatus("Saved", true);
  } catch (err) {
    showError("Could not save the API key to browser storage.");
  }
});

if (els.siteToggle) {
  els.siteToggle.addEventListener("click", async () => {
    clearError();

    const host = await activeTabHost();
    if (!host) return;

    const sites = await loadSites();
    const base = siteBase(host);
    const enabled = siteMatches(host, sites);

    // Removing also drops any parent entry that would keep this host covered.
    const next = enabled
      ? sites.filter(
          (entry) => base !== siteBase(entry) && !host.endsWith(`.${siteBase(entry)}`)
        )
      : Array.from(new Set([...sites, base]));

    try {
      await storageSet(SITES_KEY, next);
      await refreshSiteToggle();
    } catch (err) {
      showError("Could not update the overlay site list. Try again.");
    }
  });
}

for (const button of els.providerButtons) {
  button.addEventListener("click", async () => {
    const provider = button.dataset.provider;
    if (!PROVIDERS[provider] || provider === answerProvider) return;

    applyProvider(provider, { persist: true, resetInput: true });

    try {
      const saved = await storageGet(PROVIDERS[provider].storageKey);
      if (saved) {
        els.apiKey.value = saved;
        setKeyStatus("Key loaded", true);
      } else {
        setKeyStatus("", false);
        openSettings();
      }
    } catch (err) {
      setKeyStatus("", false);
    }
  });
}

els.capture.addEventListener("click", runCapture);

els.clear.addEventListener("click", () => {
  els.prompt.value = "";
  setResponse(IDLE_RESPONSE);
  clearError();
  setStatus("");
  els.prompt.focus();
});

els.copy.addEventListener("click", copyResponse);

if (els.grantAccess) {
  els.grantAccess.addEventListener("click", async () => {
    clearError();
    if (!ext || !ext.permissions || typeof ext.permissions.request !== "function") {
      showError(
        "This build cannot request screen access. Open about:addons → SnapLite → " +
          "Permissions and enable “Access your data for all websites” manually."
      );
      return;
    }
    try {
      const granted = await ext.permissions.request({ origins: ["<all_urls>"] });
      showPermissionBanner(!granted);
      if (!granted) {
        showError("Screen access was not granted, so capture will stay blocked.");
      }
    } catch (err) {
      showError(
        "Firefox could not grant screen access: " +
          (err && err.message ? err.message : String(err)) +
          " — enable it in about:addons → SnapLite → Permissions instead."
      );
    }
  });
}

if (els.closePanel) {
  els.closePanel.addEventListener("click", () => postToHost("close"));
}

if (ext && ext.runtime && ext.runtime.onMessage) {
  ext.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "snapgemini:permission-granted") return;
    clearError();
    showPermissionBanner(false);
    setStatus("Screen access granted. Press Capture & Answer.", false);
  });
}

els.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    runCapture();
  }
});

els.keyLink.addEventListener("click", (event) => {
  if (!ext || !ext.tabs || typeof ext.tabs.create !== "function") return;
  event.preventDefault();
  ext.tabs.create({ url: PROVIDERS[answerProvider].keyUrl }).catch(() => {
    /* Ignore: the plain link still works if tab creation is unavailable. */
  });
});

init();
