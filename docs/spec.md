# seiton specification

[README](../README.md) · [日本語](spec.ja.md)

Implementation details and limitations beyond the README.

## Workspaces

Each browser window has at most one active workspace. A workspace can be open in only one window; selecting an already-open workspace focuses that window. Normal switching snapshots tabs, closes them, and opens the target workspace's saved URLs. Chrome cannot hide tabs.

Snapshots include URL, title, pinned state, tab groups, active tab, and last-access time. They are saved to chrome.storage.local after changes. Each workspace references one session; sessions do not partition the workspace list. Session management can open all workspaces referencing a session in separate windows.

Switching an unassigned window first saves its tabs as an unsorted workspace. Deleting a workspace leaves its bookmark folder and open tabs intact; the window becomes unassigned. Deleting a linked bookmark folder removes the link. Incognito windows are excluded.

## Language

Settings & management → Display & behavior → Language offers Automatic (browser language), English, and 日本語. Unsupported automatic languages fall back to English. Selection is saved immediately and reflected across extension screens. User-entered names and site-provided titles are not translated. Store metadata uses the browser's extension localization mechanism separately.

## Sessions and cookies

Chrome has no per-tab or per-window cookie isolation API. One cookie session is active across the entire browser, so changing sessions affects every window. localStorage, IndexedDB, and other site storage are not isolated.

- Adding a second session shows an extension consent dialog explaining use, storage, and deletion, then requests optional cookies and all-site host permission. Refusal cancels creation. There is no independent cookie-isolation toggle: granted permission enables swapping. Existing multiple-session configurations without permission show a permission prompt in settings.
- On permission grant, the current cookies belong to the current workspace's session (or the last-used workspace's session), unless cookieSessionId is already set. A new session starts with no saved cookies.
- Before switching to another session, save current cookies, including partitioned cookies, and finish writing them before deleting them. Remove current cookies and restore the target jar, excluding expired cookies and preserving hostOnly, session, sameSite, and partitionKey properties. Then update cookieSessionId.
- During a same-window switch, old tabs close before cookie replacement to reduce contamination. A blank tab keeps the window alive until target tabs open.
- Editing the session of an open workspace swaps cookies and reloads its non-discarded tabs. Deleting the currently active session first switches to the destination session; its saved jar is then deleted.
- Saved jars use AES-GCM (256 bit), Base64 ciphertext in local storage, and a non-extractable CryptoKey in IndexedDB seiton-vault. Legacy plaintext jars are encrypted on startup/update. An undecryptable jar behaves as an empty jar and does not block switching.
- **Delete saved cookies** leaves the browser's currently active cookies intact. Jars and keys are local and excluded from export/import and sync. Encryption does not provide OS-keychain-equivalent protection against other software on the same computer.

Other windows left open in a different session use the newly active login on their next request; pages can also write cookies into that active session. This is a browser-wide login switch, not concurrent session isolation.

## Parking

Park and switch keeps current tabs in a collapsed group named with ⏸, the workspace icon, and its name/color. Pinned tabs are unpinned into the group. An otherwise empty new-tab workspace is closed normally. Parked tabs remain associated with their original workspace.

Resuming restores pinned state, original groups, and the active tab without reloading. A parked group in another window moves into the target window; opening with ⧉ moves it to a new window. Ending parking snapshots and closes the group. Manually closing every parked tab also ends parking. Renaming/recoloring updates the group; deleting its workspace makes it an ordinary group without ⏸.

The parked map in chrome.storage.session stores group ID, workspace, and original tab metadata, following tab-ID changes after discard. Browser restarts lose this metadata; restored ⏸ group titles are used to identify parked workspaces, but original pinned/group structure is lost.

Parking is rejected when a switch requires cookie replacement. Such normal switches also close parked groups in that window after saving them. Parked tabs remain subject to Chrome memory saving and auto-close; auto-close follows the containing window's settings and records the original parked workspace in closed-tab history.

## Panel, palette, and navigation

The management panel (Alt+Shift+K or ☰) is a temporary popup centered over the target window at about 85% of its size. Only one panel exists; invoking it for another window replaces it. It focuses search on opening and closes after navigation, loss of focus, or closing its target window. Esc first dismisses a dialog/editor, then search text, then the panel. Non-navigation actions such as closing a tab or freeing memory keep it open.

- Search spans workspace name/session/icon, linked bookmarks across workspaces, frequently opened pages, and browsing history if authorized. History is read only on search and can be revoked in settings. Arrow keys select, Enter opens, and / focuses search.
- ＋ creates a workspace with name, icon, session, and a new/existing/no bookmark folder. Unassigned windows may adopt existing tabs. ✎ edits name, color, icon (preset/custom/none), session, folder, and auto-close override.
- Drag workspace rows onto another row's upper/lower half to insert before/after it. Number keys 1–9 and 0 select the first ten workspaces when not editing; a nonempty search accepts digits as text. Shift opens a new window.
- The configured switchMode applies to row clicks, Enter, and number keys: normal switch, park and switch, or new window. Ctrl+Enter (⌘ on Mac) swaps the default with parking; Shift+Enter swaps it with new-window opening. Explicit ⏸ and ⧉ buttons always perform their respective actions.
- Bookmark/saved-tab rows open a single page. Existing open pages are focused. Drag a tab onto bookmarks or a workspace row to bookmark it in the linked folder; duplicate URLs and unsupported pages are rejected.
- The palette (Alt+K) incrementally searches tabs, bookmarks, frequently opened pages, and workspaces. Prefix > (or full-width equivalent), or press Tab, for workspace-only mode. Delete closes a tab result; Shift+Enter opens a bookmark in the current tab.
- Alt+Shift+D saves the current tab in the linked folder; the toolbar badge shows + (saved), = (already saved), or ! (failed, with reason in the tooltip). Alt+Shift+N selects the next workspace in the same session. Customize keys at chrome://extensions/shortcuts; previous workspace has no default.

### Moving tabs and the frequently opened shelf

Select tab checkboxes (Shift-click selects a range), choose a destination, and move in bulk. While selection exists, clicking a row toggles selection rather than opening it. An open destination receives live tabs without reload; a parked destination receives them in its group. A closed destination receives saved tabs and source tabs close. Moving saved tabs into an open workspace opens them in the background, respecting lazy loading. URLs are removed from the source snapshot. A blank tab prevents the source window from closing.

Each workspace has a shelf of frequently opened pages below bookmarks. Drag open tabs, saved tabs, or bookmarks onto it to register unique URLs. Click opens or focuses a page; × removes it; drag to reorder. Shelf items can be dragged into bookmarks and appear in panel/palette search. The shelf is exported and synced, and is retained when sync omits ordinary tabs for space.

### Workspace indicators

Toolbar icons show workspace color plus emoji or initial per window, with workspace/session tooltip. Unassigned windows use the default icon.

The optional workspace tab (on by default) is a collapsed colored group at the left of the tab strip, after pinned tabs. Its page lists workspaces and bookmarks and opens the management panel. The tab survives switches and follows edits. Closing/moving/ungrouping it or changing its group is repaired automatically; disable the setting to remove it from all windows. The tab/group is excluded from snapshots and normal tab lists. Unassigned windows close it unless it is the last tab, in which case it stays ungrouped with an unassigned display.

## Bookmarks

A workspace can link a new or existing folder. Bookmarks explicitly created through Ctrl+D or the star are moved to that folder; Alt+Shift+D saves directly. Bookmarks created through the bookmark manager or arriving through browser sync are not moved. Folder contents are searchable. Workspace deletion does not delete bookmarks.

## Memory

Prefer Chrome's built-in Memory Saver (chrome://settings/performance), which considers activity such as audio and forms. Normal workspace switching already reduces the number of open tabs. The extension uses native tabs.discard rather than replacing URLs with placeholder pages.

- Lazy loading is on by default: restore/load only the saved active tab initially; other tabs are discarded once their URLs are established, without being brought to the foreground.
- Optional automatic memory release is off by default and skips pinned and audible tabs.
- The panel's 💤 action discards inactive tabs immediately. It is separate from parking.

## Automatic tab closing

Off by default. Global settings hold autoClose = { enabled, days } (default false, 7 days). Input accepts minutes, hours, or days; the minimum is approximately 15 minutes (0.01 days). A workspace override is null (inherit) or { enabled, days }; unassigned windows use global settings.

URL exclusions in settings.autoCloseExclude support host/subdomains, host plus path prefix, full URL prefix, and * wildcards. Prefixes respect boundaries: example.com/a does not match /ab. Edit exclusions in settings or use 🛡 on a tab row for a page/site exclusion. An excluded badge removes the exclusion when clicked. Exclusions are exported/imported.

Eligible tabs are older than the threshold using lastAccessed. Active, pinned, audible, extension, excluded, and timestamp-less tabs are skipped, as is the final tab in a window. Only open tabs are affected. A 15-minute alarm runs when any global/workspace rule is enabled, first running about one minute after enabling/startup; switching windows are skipped.

Snapshots preserve lastAccessed across reopening until the restored tab is activated. This association lives in storage.session; losing it resets never-activated restored tabs to their creation time.

Closed-tab history is stored separately, newest first, capped at 500 entries. It includes URL, title, close time, original workspace ID/name, favicon, and reason. Settings groups it by date and allows search, reopen, individual delete, and double-confirmed bulk deletion. Successful reopening removes the entry; failure retains it. If its workspace has an open window, reopening uses that window. Logging failure does not block closing. Cookies and this history are excluded from export/import and sync.

## Sync

No custom account/server: chrome.storage.sync uses the browser account's extension sync service. In Chrome, Google's Chrome Sync stores the synchronized workspace/session/settings data, including saved tab URLs and titles and the metadata listed below, under your Google account. This optional browser-managed transmission is the exception to local-only storage; there is no developer-operated backend. Turn sync on in each device. Without a signed-in account it behaves locally until browser sync is available.

- Quotas: 102,400 bytes total, 8,192 per item, 512 items; 120 writes/minute and 1,800/hour.
- Tabs retain URL, title (up to 100 characters), pinned/group/active metadata, omitting favicon and last-access time. Workspace JSON is gzip-compressed and Base64-encoded, split into w.<id>.<n> chunks below 8 KB. The first chunk starts with a chunk count. Metadata m holds settings, sessions, and order. Typical 20-tab workspaces compress to about 1 KB; capacity varies.
- If oversized, omit only ordinary tabs from least-recently-opened workspaces. Keep names, colors, icons, sessions, overrides, folder paths, and shelf. Report omissions in settings. Receiving devices retain their existing tabs for omitted workspaces and may upload them if space permits.
- Debounce local writes by about 10 seconds and incoming changes by about 2 seconds to collect chunks. Write only changed items and remove obsolete chunks.
- Three-way merge compares local, remote, and syncBase per workspace/session/settings/order. One-sided changes win, including deletions. Concurrent changes use newer timestamps (ties favor local); changes beat deletion. lastOpenedAt uses the maximum. No tombstones are retained. An empty remote ignores base and gets local data republished. Enabling sync also discards base and starts with a union.
- Saved cookies, closed-tab history, favicons, last-access timestamps, lastFocusedWorkspaceId, and syncEnabled do not sync. Import preserves the local sync-enabled value.
- Bookmark-folder IDs are device-specific: sync a path of folder names, reconnect matching folders, and keep unresolved paths for later retries. Do not create missing folders automatically.
- Settings displays usage, last sync, omissions, and errors, with sync-now and delete actions. Deleting sync data clears remote storage and disables this device's sync; another enabled device may republish its local state. Startup/update imports once. Incoming settings refresh alarms/indicators. Deleted workspaces unassign their windows without closing tabs.
- Import timestamps settings/order as current and may remove workspaces remotely. A newer unsupported sync-document version is rejected.
- Simultaneous edits to one workspace on multiple computers keep the last edited tab configuration. Existing live windows are not rewritten; changes appear when reopening the workspace.

## Code and data

| Module | Responsibility |
|---|---|
| background.js | Chrome events, message handling, state writes |
| lib/core.js, store.js | Pure logic, normalized state, storage, serialized queue |
| lib/workspace.js | Switch, snapshot, restore, sessions, startup matching |
| lib/cookies.js, vault.js | Cookie swaps, permission checks, encryption and legacy migration |
| lib/syncdoc.js, sync.js | Sync format/merge/chunk/quota logic and browser API integration |
| lib/parked.js | Parking records, groups, tab-ID tracking and recovery |
| lib/bookmarks.js, memory.js, history.js | Bookmark operations, discard, closed-tab history |
| lib/indicator.js, draw.js, wstab.js | Per-window icons and workspace tab repair |
| lib/manager.js | One management popup with target windowId |
| ui/sidepanel.*, popup.*, options.*, manage.*, wstab.*, guide.* | Panel, palette, settings, management, workspace page, guide |

Persistent storage keys:

- **state:** Sessions, workspaces (session ID, color, icon, tab/group snapshots, folder ID, shelf of URL/title pairs), workspaceOrder, settings. Export/import includes this data. Legacy v1 session workspaceIds migrate on read.
- **cookieJars / cookieSessionId:** Encrypted per-session jars (savedAt, enc, iv, data) and the active cookie session. Legacy plaintext cookies arrays migrate. Encryption keys are in IndexedDB.
- **closedTabs:** Up to 500 records with id, url, title, favIconUrl, closedAt, workspaceId, workspaceName, and reason: auto.
- **syncBase / syncStatus:** Merge base and last-sync/usage/omission/error display data; not exported.
- **sync m / w.<workspaceId>.<n>:** Metadata and compressed/chunked workspaces.
- **State timestamps:** settingsAt/orderAt and session/workspace updatedAt resolve conflicts; bookmarkFolderPath preserves pending folder matches.

Session storage holds bindings (windowId → workspaceId), parked groups, and restored-tab access-time associations. Window IDs change after restart.

### Startup recovery

1. Wait up to several seconds for Chrome's tab restoration.
2. Match saved/workspace URLs to windows one-to-one: at least two matching URLs and 50% overlap, avoiding accidental matches on one common page.
3. At 80% overlap or more, add missing saved tabs without closing user tabs. Unmatched windows remain unassigned.
4. If Chrome does not restore the previous session and has only a new-tab window, open the last-used workspace.

## Known limitations

Normal switches lose in-page state; parking can preserve it until Chrome discards the tab or the browser restarts. Cookie isolation is browser-wide and does not include other site storage. Some chrome:// pages cannot be opened by extensions and are skipped.

Without file-URL access, file:// tabs are excluded from snapshots, moves, startup completion, and restoration, and left open during switches. The panel and display settings explain access; enabling **Allow access to file URLs** treats them normally. Sync quota and concurrent-edit limitations are described above.
