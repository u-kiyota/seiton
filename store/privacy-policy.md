# seiton Privacy Policy

[日本語](privacy-policy.ja.md)

Effective date: not yet specified (the original policy's date is a placeholder).

This policy describes how the seiton Chrome extension handles user information.

## 1. Information handled

| Information | Purpose | Storage |
|---|---|---|
| Tab URLs, titles, pinned state, groups, last-access timestamps | Save/restore workspaces; auto-close unused tabs | Browser (chrome.storage.local) |
| Linked bookmark-folder information and bookmarks | Link folders, search, create folders or move bookmarks in response to user actions | Browser bookmarks |
| Browsing history, only with optional permission | Panel search; read only at search time | Not stored by the extension |
| Workspace/session names and settings | Provide features | Browser |
| Auto-closed tab history (up to 500 entries) | Reopen tabs | Browser |
| Cookies, only when session functionality is enabled | Switch login state | Browser, encrypted with AES-GCM |

## 2. Transmission

- The extension does not send this information to developer or third-party servers.
- Only when you enable sync, workspace/session information and settings are stored through the browser's chrome.storage.sync service and synchronized with your other browsers signed into the same account. The developer cannot access this storage. Cookies, closed-tab history, and browsing history are not synchronized.
- No ads, analytics, or tracking.

## 3. Sharing and sale

The developer does not sell or provide information to third parties, use it for purposes unrelated to the extension, or use it to determine creditworthiness or for lending.

## 4. Deletion

Uninstalling removes local extension storage. Before uninstalling, use **Delete sync data** in settings to remove sync data. Saved cookies, closed-tab history, and sync data can also be deleted from settings at any time.

## 5. Security

Information is stored in browser extension storage; the extension makes no external network requests. Saved cookies are encrypted with AES-GCM (256 bit). The encryption key is stored as a non-extractable browser key.

## 6. Changes

Policy changes will be announced on this page.

## 7. Contact

Open an issue in the [GitHub repository](https://github.com/u-kiyota/seiton/issues).
