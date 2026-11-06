<p align="center"><img src="icons/logo.png" width="96" alt="seiton"></p>

# seiton

[![CI](https://github.com/u-kiyota/seiton/actions/workflows/ci.yml/badge.svg)](https://github.com/u-kiyota/seiton/actions/workflows/ci.yml)

[日本語](README.ja.md)

Organize tabs and bookmarks into **workspaces**, then switch between projects, clients, or research topics with one click. Keep the tabs you need for your current task in view.

- Manifest V3 Chrome extension. No build step or dependencies.
- Data stays in your browser, with optional browser-account sync. No developer server, sign-up, ads, analytics, or tracking.
- Google Chrome 121 or later. Other Chromium browsers may work, but Chrome is the tested browser.
- English and Japanese UI, with automatic selection and a manual override.

| Resource | Link |
|---|---|
| Install | [Chrome Web Store](https://chromewebstore.google.com/detail/seiton/nekhambnhfgfbjmhmpngfbchclpenkof) |
| Guide | Opens after installation; also accessible from settings and the panel's **?** button |
| Technical specification | [docs/spec.md](docs/spec.md) |
| Privacy policy | [store/privacy-policy.md](store/privacy-policy.md) |
| Contributor instructions | [AGENTS.md](AGENTS.md) |

## Features

- **Workspaces:** Save URLs, titles, pinned tabs, tab groups, and the active tab. Switch with a click or shortcut; window associations are recovered after browser restarts.
- **Park and switch:** Keep current tabs open in a collapsed ⏸ group to preserve unfinished forms and page state.
- **Bookmarks:** Link a folder to each workspace. Bookmarks saved with Ctrl+D or Alt+Shift+D go into that folder. A frequently opened shelf keeps useful pages close without making bookmarks.
- **Quick palette and management panel:** Search open tabs, workspace bookmarks, and workspaces from the keyboard. The panel can also search browsing history with optional permission.
- **Sessions:** Choose the login session each workspace uses. Adding a second session requests permission to swap site cookies. Saved cookies are encrypted with AES-GCM and stored locally.
- **Memory and cleanup:** Lazy loading, optional automatic memory release, manual memory release, and optional auto-close for unused tabs. Auto-close is off by default, supports URL exclusions, and keeps a reopenable history.
- **Sync:** Resume work on another computer using your browser account's extension sync storage (chrome.storage.sync).
- **More:** Move tabs between workspaces in bulk, see the current workspace in the toolbar and workspace tab, switch by number, and export/import settings.

A workspace references one session; a session is not a parent folder. Multiple workspaces can share a session.

## Install

### Chrome Web Store (recommended)

Open the [seiton listing](https://chromewebstore.google.com/detail/seiton/nekhambnhfgfbjmhmpngfbchclpenkof) and select **Add to Chrome**. Pin seiton using Chrome's puzzle-piece menu for quick access to the palette. The guide opens after installation.

### GitHub Release or source

Download seiton-v&lt;version&gt;.zip from [Releases](https://github.com/u-kiyota/seiton/releases) and extract it, or clone this repository. Open chrome://extensions, enable **Developer mode**, select **Load unpacked**, and choose the folder containing manifest.json.

The store and unpacked installations have separate storage. Transfer workspace data using export/import in settings.

## Get started

1. Press Alt+Shift+K, or open the toolbar palette and select **☰**, to open the management panel as a temporary window.
2. Select **＋** beside Workspaces, then choose a name and icon. An unassigned window can adopt its existing tabs.
3. Create another workspace and select its row to switch. Returning restores the first workspace's saved tabs. You can also press Alt+K, type > followed by a name, and press Enter.

### Screens

- **Management panel (Alt+Shift+K):** Workspaces, bookmarks, and tabs in one view. Search using arrow keys and Enter. Use **＋** to create, **✎** to edit, **⏸** to park and switch, and **⧉** for another window. Drag workspace rows to reorder. Select multiple tabs to move them; drag a tab onto bookmarks to save it.
- **Quick palette (Alt+K):** Search tabs, bookmarks, frequently opened pages, and workspaces. Type > or press Tab for workspace-only search.
- **Settings & management:** Open **⚙** in the panel to manage workspaces, sessions, closed tabs, language, memory, auto-close, bookmarks, shortcuts, sync, and backups.
- **Workspace tab:** A collapsed colored group on the left shows the current workspace. Open it for workspace navigation and bookmarks; disable it in settings if preferred.
- **Toolbar icon:** Shows the current window's workspace color and icon. Hover to see its name and session.

### Language

Open **Settings & management → Display & behavior → Language**. Choose **Automatic (browser language)**, **English**, or **日本語**. Automatic uses the browser language, with English as the fallback for unsupported languages. Changes save immediately and apply across extension screens. User-entered names, bookmarks, and page titles keep their original text.

### Shortcuts

| Key | Action |
|---|---|
| Alt+K | Quick palette |
| Alt+Shift+K | Open/close management panel |
| Alt+Shift+D | Bookmark current tab in workspace folder |
| Alt+Shift+N | Next workspace in the same session |
| Enter in panel/palette | Configured default: switch, park and switch, or new window |
| Ctrl+Enter (⌘+Enter on Mac) | Swap default behavior with park and switch |
| Shift+Enter | Swap default behavior with new window |
| 1–9, 0 in panel | Numbered workspace; Shift opens a new window |

Customize shortcuts at chrome://extensions/shortcuts. Previous workspace has no default key.

### Limitations

- Normal switching saves and closes tabs, then reopens URLs. Unsaved forms, scroll position, and per-tab back/forward history are lost. Use **Park and switch** to retain live pages.
- One cookie session is active across Chrome at a time; switching affects all windows. Other site storage, including localStorage, is not separated. Parking across cookie sessions is unavailable.
- Sync has a 100 KB limit. Tabs from older workspaces may be omitted. Saved cookies and closed-tab history never sync.
- Switching an unassigned window saves its tabs as an unsorted workspace first.
- Incognito is excluded. Some chrome:// pages cannot be restored.
- Without **Allow access to file URLs**, file:// tabs are neither saved nor closed during switches. Enable access on seiton's details page at chrome://extensions to handle them normally.

See [the specification](docs/spec.md) for details.

## Development

Requirements: **Node.js 22+**, **Chrome 121+**. No dependencies; npm install is unnecessary.

~~~sh
git clone https://github.com/u-kiyota/seiton.git
cd seiton
npm test       # Pure-logic unit tests
npm run check  # Manifest, files, syntax, imports, locales
~~~

Load the cloned folder with **Load unpacked** at chrome://extensions. After edits, select Reload on its extension card. Open the Service Worker link for logs. Disable the store version or change shortcuts to prevent conflicts.

| Path | Responsibility |
|---|---|
| manifest.json, _locales/{en,ja}/ | Extension definition and store metadata |
| src/background.js | Chrome events and UI messages; state-writing entry point |
| src/lib/ | Logic, persistence, workspaces, cookies, sync, and feature modules |
| src/ui/ | Panel, palette, settings, workspace tab, guide |
| test/, scripts/ | Unit tests, static validation, release ZIP generation |
| docs/, store/ | Specifications, manual checklist, listing, privacy, screenshots |

Run **npm test** and **npm run check** before committing; CI runs both. Use [the manual checklist](docs/manual-test-checklist.md) for browser behavior and mark untested cases in the PR. Choose an issue, create a feature branch, and open a PR following [AGENTS.md](AGENTS.md). Public docs are primarily English, with separate Japanese translations. UI strings support both languages; code comments and commit messages remain Japanese.

### Releases

1. Update version in manifest.json and package.json and commit.
2. Create and push a v&lt;version&gt; tag.
3. GitHub Actions validates and attaches the ZIP to the Release. Tag/manifest version mismatch fails.
4. Upload the same ZIP to the Chrome Web Store. For local generation, run npm run zip (dist/ output; use PowerShell on Windows). Draft text: [store listing](store/chrome-web-store-listing.md).

## Privacy

Data stays in your browser. The extension does not send it to developer or third-party servers. Optional sync uses the browser account's own sync service. Read the [privacy policy](store/privacy-policy.md).

## License

[MIT](LICENSE)
