# Tab Manager

A browser extension side panel that shows your live tabs, lets you save and bookmark URLs into an Epicenter workspace, and includes an AI chat drawer that can call workspace tools with inline approval.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. MIT licensed.

---

## How it works

The extension has two distinct layers of state that serve different purposes.

**Ephemeral browser state** lives in `browser-state.svelte.ts`. On load it seeds from `chrome.windows.getAll`, then stays current via Chrome's tab and window event listeners. This layer owns the live tab list and exposes actions like close, activate, pin, mute, reload, and duplicate. Nothing here persists; it's a reactive mirror of what the browser already knows.

**Synced workspace state** is the persistent layer. Saved tabs and bookmarks are stored in Epicenter workspace tables and synced across devices over WebSocket. The UI reads from these tables via `fromTable` and writes through workspace actions. This is what survives a browser restart or shows up on another device.

The side panel is a Svelte app mounted into `#app`. There's no popup and no content scripts—everything runs in the side panel, which opens when you click the extension action button. The background service worker is minimal; its only job is to open the side panel on click.

The main UI (`App.svelte`) has a search bar with case-sensitive, regex, and exact-match toggles, a unified tab list that shows open tabs grouped by window alongside saved tabs and bookmarks in a single virtualized list, per-tab actions, a command palette for bulk operations (dedupe, group by domain, sort, close by domain, save all), and a sync status indicator with reconnect and sign-out controls.

## Workspace schema

The workspace ID is `epicenter.tab-manager`. It defines six tables:

| Table | Key | Notable fields |
|---|---|---|
| `devices` | `DeviceId` | `name`, `lastSeen`, `browser` |
| `savedTabs` | `SavedTabId` | `url`, `title`, `favIconUrl?`, `pinned`, `sourceDeviceId`, `savedAt` |
| `bookmarks` | `BookmarkId` | `url`, `title`, `favIconUrl?`, `description?`, `sourceDeviceId`, `createdAt` |
| `conversations` | `ConversationId` | `title`, `parentId?`, `systemPrompt?`, `provider`, `model`, `createdAt`, `updatedAt` |
| `chatMessages` | `ChatMessageId` | `conversationId`, `role`, `parts[]`, `createdAt` |
| `toolTrust` | tool name | `trust: 'ask' \| 'always'` |

Awareness entries carry `{ deviceId, client: "extension" | "desktop" | "cli" }` so you can see which devices are currently connected.

## AI chat

The `AiDrawer` component is a sign-in-gated chat drawer that supports multiple conversations. Chat streams via SSE from the configured remote server. Workspace actions are converted to AI tools via `@epicenter/ai`'s `actionsToClientTools`, so the AI can read and write workspace data directly.

Destructive tool calls require inline approval before they execute. Each tool can also be set to "always allow," and that preference is stored in the `toolTrust` table so it syncs across all your devices.

## Development

```sh
# Start dev server against local backend
bun run dev:local

# Start dev server against production backend
bun run dev:remote

# Firefox
bun run dev:firefox

# Production build
bun run build

# Package for Chrome Web Store / Firefox Add-ons
bun run zip
bun run zip:firefox

# Type check
bun run typecheck
```

Auth uses Google OAuth via `browser.identity`. Encryption keys are applied on login.

## License

MIT
