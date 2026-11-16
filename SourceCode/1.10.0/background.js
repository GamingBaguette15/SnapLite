"use strict";

/**
 * SnapLite background event page.
 *
 * Firefox does not expose `tabs.captureVisibleTab` to extension pages that are
 * embedded in a web page (the i-Ready launcher iframe), so the capture is
 * delegated here: a top-level extension context that always has the API and the
 * activeTab/host permission granted for the tab being captured.
 */

const ext = globalThis.browser || globalThis.chrome;
const CAPTURE_OPTIONS = { format: "png" };

/** @returns {Promise<string>} data URL of the visible tab at full resolution */
function captureVisibleTab() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    try {
      const maybePromise = ext.tabs.captureVisibleTab(null, CAPTURE_OPTIONS);
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(
          (dataUrl) => finish(resolve, dataUrl),
          (err) => finish(reject, err instanceof Error ? err : new Error(String(err)))
        );
        return;
      }
    } catch (err) {
      finish(reject, err instanceof Error ? err : new Error(String(err)));
      return;
    }

    try {
      ext.tabs.captureVisibleTab(null, CAPTURE_OPTIONS, (dataUrl) => {
        const runtimeError = ext.runtime && ext.runtime.lastError;
        if (runtimeError) {
          finish(reject, new Error(runtimeError.message || "Capture failed."));
          return;
        }
        finish(resolve, dataUrl);
      });
    } catch (err) {
      finish(reject, err instanceof Error ? err : new Error(String(err)));
    }
  });
}

ext.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "snapgemini:capture") {
    return undefined;
  }

  if (message.type === "snapgemini:open-grant") {
    return ext.tabs
      .create({ url: ext.runtime.getURL("grant.html"), active: true })
      .then(() => ({ ok: true }))
      .catch((error) => ({
        ok: false,
        error: error && error.message ? error.message : "Could not open the permission tab.",
      }));
  }

  if (!ext.tabs || typeof ext.tabs.captureVisibleTab !== "function") {
    return Promise.resolve({
      ok: false,
      error:
        "Firefox has not exposed screen capture to SnapLite yet. Allow screen access " +
        "(toolbar icon → Enable screen access) and, if you already did, click Reload in " +
        "about:debugging — Firefox only attaches the capture API after a reload.",
    });
  }

  return captureVisibleTab()
    .then((dataUrl) => ({ ok: true, dataUrl }))
    .catch((error) => ({
      ok: false,
      error: error && error.message ? error.message : "Could not capture the current tab.",
    }));
});
