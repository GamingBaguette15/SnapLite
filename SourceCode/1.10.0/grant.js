"use strict";

/**
 * Top-level permission page.
 *
 * Firefox only shows the optional-permission prompt from a top-level extension
 * document, so this page exists to request `<all_urls>` (needed by
 * tabs.captureVisibleTab) on the user's click and then get out of the way.
 */

const ext = globalThis.browser || globalThis.chrome;
const button = document.getElementById("grant");
const statusEl = document.getElementById("status");
const REQUEST = { origins: ["<all_urls>"] };

function setStatus(text) {
  statusEl.textContent = text;
}

if (!ext || !ext.permissions || typeof ext.permissions.request !== "function") {
  button.disabled = true;
  setStatus("This build of Firefox cannot grant screen access. Use the toolbar popup instead.");
}

async function closeCurrentTab() {
  try {
    const tab = await ext.tabs.getCurrent();
    if (tab && typeof tab.id === "number") {
      ext.tabs.remove(tab.id);
      return;
    }
  } catch (err) {
    // Closing is a convenience only.
  }
  window.close();
}

async function grant() {
  button.disabled = true;
  setStatus("Waiting for Firefox…");

  let granted = false;
  try {
    granted = await ext.permissions.request(REQUEST);
  } catch (err) {
    setStatus(
      "Firefox rejected the request: " +
        (err && err.message ? err.message : String(err)) +
        " — try again from the toolbar popup."
    );
    button.disabled = false;
    return;
  }

  if (!granted) {
    setStatus("Permission was not granted. Click the button to try again.");
    button.disabled = false;
    return;
  }

  setStatus("Screen access granted. Returning to your page…");

  try {
    await ext.runtime.sendMessage({ type: "snapgemini:permission-granted" });
  } catch (err) {
    // The panel may be closed; the permission is still saved.
  }

  window.setTimeout(closeCurrentTab, 700);
}

button.addEventListener("click", grant);
