# Manual test checklist

[日本語: detailed scenarios](manual-test-checklist.ja.md)

Automated tests cover pure logic and Chrome API fakes. Run relevant scenarios in real Chrome and mark unperformed cases **Not verified** in the PR. The linked Japanese checklist preserves the detailed original scenarios.

## Language

- [ ] Fresh install with Japanese browser language selects Japanese automatically; English and unsupported browser languages select English.
- [ ] Settings & management → Display & behavior → Language switches between Automatic (browser language), English, and 日本語, saves immediately, and survives extension/browser restart.
- [ ] Open panel, palette, settings, workspace tab, and guide together; changing language updates their headings, controls, tooltips, dialogs, empty states, toasts, and dynamic counts without losing user data.
- [ ] Create, edit, search, switch, park, resume, move tabs, manage sessions, and show permission/error messages in both languages. No missing translation keys or mixed-language extension text appears.
- [ ] User-entered workspace/session names and page/bookmark titles remain unchanged. Check narrow layouts and long English labels for clipping and keyboard access.
- [ ] Export/import and sync keep a valid language preference. Older data without a language setting uses automatic selection.

## Workspaces and navigation

- [ ] Create A, open multiple tabs, create/switch to B, then return to A. Restore pinned state, group names/colors, active tab, and lazy loading without flashing other tabs into the foreground.
- [ ] Creation supports icons (preset/custom/none), session choice, new/existing/no folder, and adopting tabs from an unassigned window. Linking an existing folder does not create another.
- [ ] Panel shows workspace/bookmark/tab columns without stray null values. Row click switches the target window, closes the panel after completion, and never switches the panel's own window.
- [ ] Select an already-open workspace to focus its existing window. Close/reopen a workspace window without losing its snapshot.
- [ ] Restart Chrome with previous-session restoration on/off; reload the extension; window associations and saved tabs survive correctly.
- [ ] Drag workspace rows before/after others, including adjacent no-op drops. Numbers update and dragging does not trigger switching.
- [ ] Number keys 1–9/0 switch; Shift opens a new window. Inputs, editing, dialogs, and nonempty search accept digits normally; selecting the active number is harmless.
- [ ] Palette searches tabs/bookmarks/workspaces; > or Tab restricts to workspaces. Arrow/Enter, Shift+Enter, Ctrl/⌘+Enter, Delete, and customized shortcuts behave correctly.
- [ ] Default normal/park/new-window modes apply to Enter, row click, and numbers. Ctrl/Shift modifiers and displayed hints correctly swap behavior.

## Panel and settings

- [ ] Alt+Shift+K toggles one popup centered over the target window at about 85% size; invoking from another window replaces it. Palette ☰ and guide open the same panel.
- [ ] Focus loss closes the panel; interacting with dialogs/selects/icon fields does not. Esc dismisses dialog/editor/search before closing the panel.
- [ ] Navigation focuses the destination and closes the panel; tab close and memory release keep it open. Search focuses initially and / refocuses it.
- [ ] Settings sections, direct # links, narrow-screen menus, existing settings-tab reuse, and workspace/session/closed-tab management work.
- [ ] Inline name/session/auto-close edits, color/icon changes, drag ordering, select-all, and bulk changes persist without switching workspaces. Delete requires confirmation and preserves bookmark folders/open tabs.

## Bookmarks and indicators

- [ ] Ctrl+D and Alt+Shift+D use the linked folder; bookmark-manager/sync-created bookmarks are not moved. Toolbar +/= /! badge states and error tooltip are correct.
- [ ] Drag a tab onto bookmarks/workspace rows; save once per URL. Deleting linked folders removes the link; deleting workspaces leaves bookmarks intact.
- [ ] Toolbar icon/color/initial/session tooltip remains correct per window through switching, edits, navigation, tab creation, and bookmark badges. Unassigned/panel windows use default icons.
- [ ] Workspace label sits after pinned tabs on the left. Its page navigates workspaces/bookmarks and opens the panel. Edits/switches update it; it never appears in normal lists or saved snapshots.
- [ ] Closing/moving/ungrouping/recoloring its tab/group repairs it; disabling removes it in all windows. Unassign/delete removes it except when it is the last tab. Restart reuses it without duplication or emptying saved user tabs.

## Permissions and sessions

- [ ] History is absent until explicitly allowed through search. Grant shows same-query results; revoke in settings removes access. Search/open/escape behavior remains correct; no required history permission warning at installation.
- [ ] Adding a second session shows storage/deletion consent followed by optional Chrome cookies/all-sites permission. Cancel/deny adds nothing; allow creates an initially logged-out session.
- [ ] Switch between two sessions logged into different accounts, then return: cookies and active-session status/count/time labels follow correctly. Windows stay alive, target login is correct, and restart immediately after switching keeps it.
- [ ] Editing an open workspace's session swaps cookies and reloads its live tabs; deleting the current session swaps to the destination first. Saved-cookie deletion requires confirmation and leaves active cookies intact.
- [ ] DevTools local cookieJars contain encrypted enc/iv/data fields with no plaintext names/values; IndexedDB seiton-vault holds a key. Legacy plaintext jars migrate on reload and still restore correctly.
- [ ] Import does not remove saved cookies or permissions. Test revoked cookie permission on existing multiple-session data.

## Memory and auto-close

- [ ] Lazy loading restores only the active page initially. Manual and timed memory release discard eligible inactive tabs, skip pinned/audible tabs, and do not create parked groups.
- [ ] Enable auto-close at 15 minutes and wait 15–30 minutes. Eligible tabs close; active/pinned/audible/extension tabs and the final tab remain. Test inherit/disabled/enabled-duration workspace overrides.
- [ ] Closed-tab count badges, date groups, title/URL search, reopening into the correct window, failed reopen retention, single delete, and double-confirmed delete-all work, with a 500-entry cap.
- [ ] Add/edit/delete URL exclusions; empty/duplicate input is rejected. 🛡 page/site registration and excluded badge removal update settings immediately. Excluded tabs remain after the threshold, and a window with only excluded tabs remains open.
- [ ] Export/import restores configuration and exclusions.

## Sync (two signed-in browsers/profiles)

- [ ] Enable extension sync on both devices. Workspaces, sessions, tabs, shelf, settings, and order arrive; usage/last-sync display updates; pre-existing data on both devices survives.
- [ ] Rename/recolor/reorder/add sessions/change settings and tabs; changes arrive after debounce. Delete propagates unless the other device independently edited the workspace; live tabs are not closed.
- [ ] Folder paths reconnect existing browser-synced bookmarks; missing paths stay pending and reconnect later without creating duplicate folders.
- [ ] Sync-now updates status; disable/enable works. Delete-sync-data empties storage and disables this device; another enabled device republishes its local data without losing workspaces.
- [ ] Fill storage near 100 KB: old workspaces show omitted-tab warnings/badges; metadata and shelf still sync, and remote existing tabs remain. Unsupported document versions show an error.
- [ ] Incoming settings refresh alarms, toolbar icons, and workspace tabs. Export/import preserves this device's sync-enabled setting.

## Parking

- [ ] Park A while opening B: collapsed ⏸ group keeps live form/scroll state; pinned tabs enter unpinned, snapshots retain original metadata, and badges/details show parking.
- [ ] Resume A by click/Enter/Ctrl+Enter; groups/pins/active tab restore without reload. B closes or parks according to the selected/default action.
- [ ] End parking or close all group tabs: save the final snapshot and remove parking indicators.
- [ ] Resume parked A from another window or with ⧉: move live tabs and preserve page state. Rename/color updates the group; delete workspace makes it ordinary.
- [ ] Cross-cookie-session parking is rejected without changes. Normal cross-session switching closes/saves parked groups; creation hides unavailable parking choice.
- [ ] Restart with a parked group: recover parking from its title and resume (original pins/groups are not recoverable). Reload extension as well.

## Tab moves and frequently opened shelf

- [ ] Select individual/range/all tabs; row clicks toggle selection while selected. Closed destinations receive snapshots, open destinations receive live tabs without reload, parked destinations receive group tabs. Source windows remain alive when emptied.
- [ ] Move saved tabs into an open destination in the background with lazy loading. Source snapshots update. No-destination state is explained.
- [ ] Drag tabs/saved tabs/bookmarks to the shelf; duplicate URLs are rejected. Click opens/focuses, × removes, drag reorders, and dragging into bookmarks registers the page.
- [ ] Shelf search/palette results include workspace context; opening uses its existing window if available. Shelf survives export/import and sync.

## Local files

- [ ] With file-URL access off, switch away from a workspace containing file:// tabs: they remain open and are not saved; hints explain this. Moving them is rejected; settings opens extension details.
- [ ] Enable file-URL access, return to settings, and confirm permission status updates. File tabs now save, close on switch, and restore normally.
