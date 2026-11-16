A Firefox extension that screenshots the page you're on, asks a vision model, and draws the answer **directly on the question** — short answers in a panel, plus callout bubbles with arrows anchored to the real answer fields.

Built for homework, quiz and math-practice sites (i-Ready, Mathopolis, or anything you opt in), but it works on any page you enable.

![Firefox](https://img.shields.io/badge/Firefox-142%2B-FF7139?logo=firefoxbrowser&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![No build step](https://img.shields.io/badge/build-none%20required-brightgreen)

---

## Features

- **Full-resolution PNG capture** of the visible tab (`captureVisibleTab`), not a downscaled thumbnail.
- **Two answer providers**, switchable in the popup:
  - **Gemini 3.5 Flash-Lite** — fast, generous free tier, structured JSON output.
  - **NVIDIA Nemotron 3.5 Super VL** — strong screenshot-math model, reasoning left **on**, streamed over SSE.
- **Answers drawn on the page.** A floating launcher opens a panel, and callout bubbles with SVG arrows point at the exact fields.
- **DOM-anchored placement.** The content script lists the page's real inputs and choice buttons, numbers them, and sends their labels to the model. A returned `targetId` is measured with `getBoundingClientRect()` at layout time — so bubbles follow scrolling, reflow and fullscreen instead of relying on pixel guessing.
- **Exact answer → choice matching.** If the answer is verbatim one of the on-page options, it anchors to that button with no model involved.
- **Decision-API locator.** When nothing matches, `gemini-decision-1` answers a batch of calibrated yes/no questions over a screenshot grid (10×6 → 6×5 → 5×5) to find the field.
- **Iframe aware.** Injected into every frame (`all_frames`), so lessons rendered inside nested iframes still contribute their answer targets.
- **Per-site opt-in.** Enable or remove the overlay for the current site from the toolbar popup; it stays dormant everywhere else.
- **Keyboard-first.** Enter submits, Shift+Enter adds a newline, Escape closes the panel.
- **Your keys, your browser.** API keys live in `browser.storage.local`; there is no backend, no analytics, no telemetry.

## How it works

```
toolbar / in-page launcher
          │
          ▼
  captureVisibleTab (background)  ──►  PNG screenshot
          │
          ├─ DOM context: question text + numbered answer targets (all frames)
          ▼
   vision model (Gemini or NVIDIA)  ──►  { answer, annotations:[{ text, targetId, target }] }
          │
          ▼
  anchor resolution: DOM element → label match → Decision pick → pixel locator
          │
          ▼
  bubbles + arrows drawn in a shadow root over the page
```

## Install

### Signed XPI
Go to releases and then click the .xpi file and firefox will promt you to install it

## Setup

Open the toolbar popup → **API key**:

1. Pick a provider: **Gemini 3.5 Flash-Lite** or **NVIDIA Nemotron VL**.
2. Paste the matching key and hit **Save key**:
   - Gemini — https://aistudio.google.com/app/apikey (`AIza…`)
   - NVIDIA — https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b (`nvapi-…`)
3. Each provider keeps its own key, so switching never loses the other one.

## Usage

1. Open a quiz/math page and click the toolbar icon.
2. In **Overlay on this site**, press **Add** — the green sparkle launcher appears bottom-left (removing hides it again, no reload needed).
3. Click the launcher, type a prompt (or leave it empty for "answer the question on screen"), press **Enter**.
4. Status moves through **Capturing… → Thinking… → Pointing…**, then the answer shows in the panel and as bubbles on the page.
5. **Copy Response** copies the text. Bubbles close individually, and closing forgets them.

Defaults when no site list exists yet: `i-ready.com`, `mathopolis.com` (subdomains included).

## Privacy and permissions

SnapLite has no server of its own. The screenshot and extracted page text go **only** to the provider you selected:

| Data | Where it goes |
| --- | --- |
| Screenshot (PNG) | Gemini and/or the NVIDIA endpoint you enabled |
| Question/answer text read from the DOM | same provider as the screenshot |
| Gemini API key | Google `generativelanguage.googleapis.com` |
| NVIDIA API key | `integrate.api.nvidia.com` |
| Prompt + API key + site list | `browser.storage.local` on your machine only |

Mozilla requires the manifest to declare this: `browser_specific_settings.gecko.data_collection_permissions.required = ["websiteContent"]`.

Permissions used:

- `activeTab`, `storage` — tab capture on demand, local settings.
- `https://*/*`, `http://*/*` — inject the dormant overlay script, read page DOM targets, capture the visible tab.
- `generativelanguage.googleapis.com`, `integrate.api.nvidia.com` — the two model endpoints.

Free tiers are rate-limited (Gemini Flash-Lite is generous, e.g. ~10 RPM / 500 RPD at the time of writing; NVIDIA's hosted endpoint is credit/rate limited and its free tier may log requests). Expect 429s if you hammer it.

## Project layout

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest: id, permissions, content script, data declaration |
| `popup.html` | Toolbar popup, also loaded inside the in-page panel |
| `popup.js` | Capture routing, providers, prompt/schema, anchoring, answer shaping |
| `content.js` | Launcher, panel iframe, bubbles, arrows, DOM target collection |
| `background.js` | Performs the tab capture for the embedded panel |
| `grant.html` / `grant.js` | Top-level page where Firefox can show the screen-access prompt |
| `styles.css` | Dark green/black theme |
| `icons/icon-*.png` | 16–128 px icons |

Storage keys: `geminiApiKey`, `nvidiaApiKey`, `answerProvider`, `overlaySites`.

## Development

No bundler, no dependencies, no build step — the XPI is just a zip of the source.

```bash
# syntax check
node --check popup.js && node --check content.js

# package
zip -r SnapLite.xpi manifest.json popup.html popup.js styles.css content.js \
  background.js grant.html grant.js icons

# validate like AMO does
npx addons-linter SnapLite.xpi
```

Debugging: `about:debugging` → **Inspect** opens the extension console. Every placement decision logs a `SnapLite anchor: …` line (`model targetId`, `label match`, `decision choice`, `falling back to pixels`, `box …`), which is the fastest way to see why a bubble landed where it did.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "This browser does not support tab capture" | The page needs the all-sites host permission; reload the add-on, then reload the tab. |
| No launcher on a site | Open the toolbar popup and press **Add** for that hostname. |
| "NVIDIA API key was not accepted" | Re-save the `nvapi-…` key for the NVIDIA provider. |
| 429 / quota errors | Free-tier limit hit — wait, or switch provider. |
| Bubble in the wrong place | Check the console `SnapLite anchor:` line; DOM anchors are exact, pixel fallbacks are approximate. |
| Add-on disappears after restart | It was loaded as temporary — install a signed XPI. |

## Limitations

- Vision grounding is best-effort on pages with no addressable DOM targets (canvas-rendered questions, cross-origin frames that block access).
- Reasoning models cost latency: Nemotron with thinking on takes several seconds per capture.
- The overlay is a single shadow-root UI; pages with their own fullscreen overlays can sit above it.
- Only the visible viewport is captured — scroll or zoom out for long questions.

## Disclaimer

SnapLite is a study/testing tool. Using it to complete graded work may violate your school's or the site's academic-integrity policy — that's on you, not the extension.
