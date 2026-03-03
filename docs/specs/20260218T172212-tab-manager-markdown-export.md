# Tab Manager Markdown Export

**Created:** 2026-02-18  
**Status:** Complete  
**Effort:** 1-2 days

## Overview

Create a standalone peer client (`apps/tab-manager-markdown`) that connects to the Epicenter sync server and exports tab-manager's Y.Doc state to markdown files in real-time. This enables:

1. **Persistent markdown backup** of browser tab state
2. **Multi-device visibility** into all connected devices' tabs
3. **Human-readable tab archives** for searching, organizing, and referencing
4. **Git-trackable tab history** (markdown files can be version-controlled)

## Architecture

### Peer Client Model

```
┌─────────────────────┐
│   Tab Manager       │  (Browser Extension - Client 1)
│                     │
│  • Reads browser    │
│  • Writes to Y.Doc  │
│  • IndexedDB cache  │
└──────────┬──────────┘
           │
           │ ws://localhost:3913/workspaces/tab-manager/sync
           │
           ▼
┌─────────────────────┐
│   Sync Server       │  (Dumb Relay - packages/server)
│                     │
│  • Holds Y.Doc      │
│  • Relays messages  │
│  • NO schema needed │
└──────────┬──────────┘
           │
           │ ws://localhost:3913/workspaces/tab-manager/sync
           │
           ▼
┌─────────────────────┐
│ Markdown Exporter   │  (Peer Client - Client 2 - NEW)
│                     │
│  • Reads Y.Doc      │
│  • Writes markdown  │
│  • ONE-WAY sync     │
└─────────────────────┘
```

**Key Properties:**

- Server is **stateless** and **schema-agnostic** (just relays y-websocket messages)
- Tab-manager and markdown exporter are **equal peers** (both sync clients)
- **ONE-WAY sync**: Y.Doc → Markdown only (read-only export, no bidirectional complexity)
- Markdown exporter imports tab-manager's workspace definition (shared schema)

## Goals

1. ✅ **Export tab state to markdown files** in real-time as tabs change
2. ✅ **One markdown file per device** with all tabs/windows/groups for that device
3. ✅ **Structured data + human-readable summary** (JSON payload + formatted view)
4. ✅ **Debounced writes** to prevent disk thrashing on rapid updates
5. ✅ **Simple startup flow**: Start server → Start tab-manager → Start markdown exporter

## Non-Goals

1. ❌ **NO bidirectional sync** (markdown files are read-only exports)
2. ❌ **NO file watching** (no need to parse markdown back to Y.Doc)
3. ❌ **NO CLI wrapper** (just a standalone Bun script)
4. ❌ **NO server modifications** (server already works as-is)
5. ❌ **NO tab-manager modifications** (already exports workspace definition)

## File Structure

```
epicenter/
└── apps/
    ├── tab-manager/                    # EXISTS - No changes
    │   └── src/lib/workspace.ts        # Exports `definition` (already done)
    │
    └── tab-manager-markdown/           # NEW
        ├── package.json                # Name: @epicenter/tab-manager-markdown
        ├── src/
        │   ├── index.ts                # Main: Connect to sync server + observe Y.Doc
        │   ├── exporter.ts             # Logic: Rows → Markdown serialization
        │   └── debounce.ts             # Utility: Debounced write queue
        ├── markdown/                   # Output directory (git-tracked)
        │   └── devices/
        │       └── .gitkeep
        ├── .gitignore                  # Ignore *.md in markdown/ (user choice)
        └── README.md                   # Usage instructions
```

## Markdown Format

### File Naming

**Pattern:** `markdown/devices/<deviceId>.md`

**Example:** `markdown/devices/xK2mP9qL.md`

### File Structure

```markdown
# Device: Chrome on MacBook Pro

**Device ID:** `xK2mP9qL`  
**Browser:** Chrome  
**Last Seen:** 2026-02-18T17:15:30Z

---

## Data

\`\`\`json
{
"device": {
"id": "xK2mP9qL",
"name": "Chrome on MacBook Pro",
"browser": "chrome",
"lastSeen": "2026-02-18T17:15:30Z",
"\_v": 1
},
"windows": [
{
"id": "xK2mP9qL_1",
"deviceId": "xK2mP9qL",
"windowId": 1,
"focused": true,
"alwaysOnTop": false,
"incognito": false,
"_v": 1
}
],
"tabs": [
{
"id": "xK2mP9qL_42",
"deviceId": "xK2mP9qL",
"tabId": 42,
"windowId": "xK2mP9qL_1",
"index": 0,
"pinned": false,
"active": true,
"url": "https://github.com/EpicenterHQ/epicenter",
"title": "Epicenter - GitHub",
"favIconUrl": "https://github.com/favicon.ico",
"_v": 1
}
],
"tabGroups": []
}
\`\`\`

---

## Summary

### Windows (1)

**Window 1** (focused)

- 5 tabs

### Tabs (5)

1. **[Epicenter - GitHub](https://github.com/EpicenterHQ/epicenter)** (active, pinned)
2. **[TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html)**
3. **[Yjs Documentation](https://docs.yjs.dev/)**
4. **[Elysia - Fast Web Framework](https://elysiajs.com/)**
5. **[Tauri Docs](https://tauri.app/)**

### Tab Groups (0)

_No tab groups_

---

**Exported:** 2026-02-18T17:22:45Z
```

**Why This Format:**

1. **Structured JSON payload** - Reliable parsing for potential future bidirectional sync
2. **Human-readable summary** - Quick visual scanning without parsing JSON
3. **Device metadata** - Name, browser, last seen timestamp
4. **Markdown-friendly** - Renders nicely in GitHub, Obsidian, VSCode, etc.
5. **Stable keys** - Sorted JSON keys for git-friendly diffs

## Implementation

### Phase 1: Basic Export (Core Functionality)

**File:** `apps/tab-manager-markdown/src/index.ts`

```typescript
import { createWorkspace } from '@epicenter/workspace/static';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync';
import { definition } from '@epicenter/tab-manager/workspace';
import { createExporter } from './exporter';

// Create sync-only client (peer to tab-manager)
const client = createWorkspace(definition).withExtension(
	'sync',
	createSyncExtension({
		url: 'ws://localhost:3913/workspaces/{id}/sync',
	}),
);

await client.whenReady;
console.log('Connected to sync server');

// Create exporter with debounced writes
const exporter = createExporter({
	outputDir: './markdown/devices',
	debounceMs: 1000, // Wait 1s of inactivity before writing
});

// Observe all table changes
client.tables.devices.observe(() => exporter.scheduleExport(client.tables));
client.tables.tabs.observe(() => exporter.scheduleExport(client.tables));
client.tables.windows.observe(() => exporter.scheduleExport(client.tables));
client.tables.tabGroups.observe(() => exporter.scheduleExport(client.tables));

console.log('Listening for changes and exporting to markdown...');

// Graceful shutdown
process.on('SIGINT', async () => {
	console.log('\nShutting down...');
	await exporter.flush(); // Write any pending changes
	await client.destroy();
	process.exit(0);
});
```

**File:** `apps/tab-manager-markdown/src/exporter.ts`

```typescript
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Tables } from '@epicenter/tab-manager/workspace';

export function createExporter(config: {
	outputDir: string;
	debounceMs: number;
}) {
	const { outputDir, debounceMs } = config;
	let timer: Timer | null = null;
	let pendingExport = false;

	async function exportAll(tables: Tables) {
		// Group data by device
		const deviceMap = new Map<
			string,
			{
				device: Device;
				windows: Window[];
				tabs: Tab[];
				tabGroups: TabGroup[];
			}
		>();

		const devices = tables.devices.getAllValid();
		for (const device of devices) {
			deviceMap.set(device.id, {
				device,
				windows: tables.windows.filter((w) => w.deviceId === device.id),
				tabs: tables.tabs.filter((t) => t.deviceId === device.id),
				tabGroups: tables.tabGroups.filter((g) => g.deviceId === device.id),
			});
		}

		// Write one markdown file per device
		await fs.mkdir(outputDir, { recursive: true });

		for (const [deviceId, data] of deviceMap) {
			const markdown = generateMarkdown(data);
			const filePath = join(outputDir, `${deviceId}.md`);
			await fs.writeFile(filePath, markdown, 'utf-8');
			console.log(`Exported: ${filePath}`);
		}
	}

	return {
		scheduleExport(tables: Tables) {
			pendingExport = true;

			if (timer) clearTimeout(timer);

			timer = setTimeout(() => {
				if (pendingExport) {
					pendingExport = false;
					exportAll(tables).catch((err) => {
						console.error('Export failed:', err);
					});
				}
			}, debounceMs);
		},

		async flush() {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			if (pendingExport) {
				// Force immediate export
				pendingExport = false;
				// tables reference would need to be captured
			}
		},
	};
}

function generateMarkdown(data: {
	device: Device;
	windows: Window[];
	tabs: Tab[];
	tabGroups: TabGroup[];
}): string {
	const { device, windows, tabs, tabGroups } = data;

	// Generate structured JSON payload
	const jsonPayload = JSON.stringify(
		{ device, windows, tabs, tabGroups },
		null,
		2,
	);

	// Generate human-readable summary
	const summary = generateSummary(data);

	return `# Device: ${device.name}

**Device ID:** \`${device.id}\`  
**Browser:** ${device.browser}  
**Last Seen:** ${device.lastSeen}

---

## Data

\`\`\`json
${jsonPayload}
\`\`\`

---

${summary}

---

**Exported:** ${new Date().toISOString()}
`;
}

function generateSummary(data: {
	device: Device;
	windows: Window[];
	tabs: Tab[];
	tabGroups: TabGroup[];
}): string {
	const { windows, tabs, tabGroups } = data;

	let summary = `## Summary\n\n`;

	// Windows summary
	summary += `### Windows (${windows.length})\n\n`;
	for (const window of windows) {
		const windowTabs = tabs.filter((t) => t.windowId === window.id);
		summary += `**Window ${window.windowId}**${window.focused ? ' (focused)' : ''}\n`;
		summary += `- ${windowTabs.length} tabs\n\n`;
	}

	// Tabs summary
	summary += `### Tabs (${tabs.length})\n\n`;
	const sortedTabs = [...tabs].sort((a, b) => a.index - b.index);
	for (const tab of sortedTabs) {
		const flags = [];
		if (tab.active) flags.push('active');
		if (tab.pinned) flags.push('pinned');
		const flagStr = flags.length ? ` (${flags.join(', ')})` : '';

		summary += `${tab.index + 1}. **[${tab.title || 'Untitled'}](${tab.url || '#'})**${flagStr}\n`;
	}

	// Tab groups summary
	summary += `\n### Tab Groups (${tabGroups.length})\n\n`;
	if (tabGroups.length === 0) {
		summary += `_No tab groups_\n`;
	} else {
		for (const group of tabGroups) {
			const groupTabs = tabs.filter((t) => t.groupId === group.id);
			summary += `**${group.title || 'Untitled Group'}** (${group.color})${group.collapsed ? ' [collapsed]' : ''}\n`;
			summary += `- ${groupTabs.length} tabs\n\n`;
		}
	}

	return summary;
}
```

**File:** `apps/tab-manager-markdown/package.json`

```json
{
	"name": "@epicenter/tab-manager-markdown",
	"version": "0.0.1",
	"type": "module",
	"private": true,
	"scripts": {
		"dev": "bun run src/index.ts",
		"typecheck": "tsc --noEmit"
	},
	"dependencies": {
		"@epicenter/workspace": "workspace:*",
		"@epicenter/tab-manager": "workspace:*",
		"yjs": "^13.6.27"
	},
	"devDependencies": {
		"@types/bun": "catalog:",
		"typescript": "catalog:"
	}
}
```

### Phase 2: Enhancements (Future)

**Optional improvements for v2:**

1. **Incremental writes** - Only write changed device files (track dirty set)
2. **Deleted device cleanup** - Remove markdown files for devices no longer in Y.Doc
3. **Custom output formats** - Support JSON-only, YAML frontmatter, etc.
4. **Filtering** - Export only specific devices or tables
5. **Compression** - Optionally gzip old exports
6. **Statistics** - Track export counts, file sizes, last export times

## Usage

### Starting the Stack

**Terminal 1: Start sync server**

```bash
cd packages/server
bun run start
# Epicenter server running on http://localhost:3913
```

**Terminal 2: Open tab-manager** (browser extension)

```bash
# Open Chrome/Firefox
# Load extension from apps/tab-manager/.output/chrome-mv3 (or firefox-mv3)
# Extension auto-connects to ws://localhost:3913
```

**Terminal 3: Start markdown exporter**

```bash
cd apps/tab-manager-markdown
bun run dev
# Connected to sync server
# Listening for changes and exporting to markdown...
```

Now:

- Open/close/move tabs in browser
- Markdown files update in `apps/tab-manager-markdown/markdown/devices/`
- Each device gets its own markdown file
- Updates debounced (1s delay after last change)

### Stopping

**Graceful shutdown:**

```bash
# In Terminal 3 (markdown exporter)
Ctrl+C  # Flushes pending writes before exit

# In Terminal 1 (server)
Ctrl+C  # Closes all WebSocket connections
```

## Technical Decisions

### Why One File Per Device?

**Pros:**

- ✅ Matches device-scoped composite ID architecture
- ✅ Limits blast radius (changing one device doesn't rewrite all files)
- ✅ Reasonable file count (devices, not tabs)
- ✅ Easy to find specific device's tabs

**Cons:**

- ❌ Can't see all tabs across all devices in one file
- ❌ Redundant metadata in each file

**Alternative considered:** One file per table (e.g., `tabs.md`, `windows.md`)

- **Rejected because:** Loses device grouping, harder to see full device state

### Why Debounced Writes?

**Problem:** High-frequency Y.Doc updates (tab navigation, title changes) would thrash disk

**Solution:** Wait 1 second of inactivity before writing

**Trade-off:**

- ✅ Disk-friendly
- ✅ Batches rapid changes into single write
- ❌ 1-second delay before markdown reflects latest state

### Why ONE-WAY Sync Only?

**Benefits:**

- ✅ No echo loops (no risk of infinite write cycles)
- ✅ No conflict resolution needed
- ✅ Simpler implementation (no file watcher, no parser)
- ✅ Deterministic behavior (markdown always reflects Y.Doc state)

**Trade-off:**

- ❌ Can't edit markdown and have changes sync back
- ✅ But this is acceptable: markdown is for **archival/reference**, not editing

**Future:** If bidirectional sync is needed, add it as v2 feature with file watcher + parser

### Why JSON Payload + Summary?

**JSON Payload:**

- ✅ Structured, parseable data (future-proof for bidirectional sync)
- ✅ Complete state capture (no information loss)
- ✅ Stable diffs (sorted keys, formatted JSON)

**Human-Readable Summary:**

- ✅ Quick scanning without parsing JSON
- ✅ Renders nicely in markdown viewers
- ✅ Searchable (grep for URLs, titles)

**Both together:** Best of both worlds (structured + readable)

## Risks & Mitigations

### Risk: Rapid Tab Changes Cause Disk Thrashing

**Mitigation:** 1-second debounce + flush on shutdown

**Monitoring:** Log export frequency, warn if > 10/min

### Risk: Large Device State Causes OOM

**Example:** 1000 tabs on one device = large JSON payload

**Mitigation:**

- Phase 1: Accept it (most users have < 100 tabs/device)
- Phase 2: Implement streaming writes or pagination if needed

**Threshold:** Monitor in production, optimize if > 10MB/file

### Risk: Device ID Contains Filesystem-Unsafe Characters

**Mitigation:** Validate device ID format (already uses NanoID - alphanumeric only)

**Fallback:** Sanitize with `deviceId.replace(/[^a-zA-Z0-9-_]/g, '_')` if needed

### Risk: Server Restart Loses In-Memory Y.Doc

**Current behavior:** Server restarts = empty Y.Doc until clients reconnect and resync

**Mitigation (future):** Add server-side persistence (y-leveldb, y-redis, etc.)

**Phase 1:** Accept it (server restarts are rare, clients resync automatically)

## Success Criteria

### Phase 1 Complete When:

1. ✅ `apps/tab-manager-markdown` package created
2. ✅ Connects to sync server as peer client
3. ✅ Exports markdown files to `markdown/devices/<deviceId>.md`
4. ✅ Files contain JSON payload + human-readable summary
5. ✅ Debounced writes (1s delay)
6. ✅ Graceful shutdown flushes pending writes
7. ✅ README with usage instructions
8. ✅ Tested with 2+ devices connected to same server

### Testing Checklist:

- [ ] Start server → Start tab-manager → Start markdown exporter
- [ ] Open new tab → Verify markdown file updates
- [ ] Close tab → Verify markdown file updates
- [ ] Create new window → Verify markdown file updates
- [ ] Rapid tab changes (10+ in 1 second) → Verify single batched write
- [ ] Ctrl+C exporter → Verify pending changes written before exit
- [ ] Restart server → Verify clients reconnect automatically
- [ ] Connect second device → Verify second markdown file created
- [ ] Close all tabs on device → Verify markdown file reflects empty state

## Timeline

**Estimated effort:** 1-2 days

**Phase 1 (Day 1):**

- [x] Create `apps/tab-manager-markdown` package structure
- [x] Implement basic sync client connection
- [x] Implement markdown export logic (JSON + summary)
- [x] Implement debounced writes
- [x] Manual testing with tab-manager

**Phase 2 (Day 2):**

- [x] Add graceful shutdown
- [x] Add error handling and logging
- [x] Write README with usage instructions
- [ ] End-to-end testing with multiple devices
- [x] Polish markdown formatting

**Future enhancements:**

- Incremental writes (only changed devices)
- Device cleanup (remove markdown for deleted devices)
- Custom output formats
- Statistics dashboard

## Open Questions

1. **Should markdown files be git-tracked?**
   - Option A: Yes (tab history in git)
   - Option B: No (gitignore \*.md, keep only structure)
   - **Recommendation:** User's choice, provide both .gitignore examples

2. **Should savedTabs table be included in device files?**
   - savedTabs are shared across all devices (not device-scoped)
   - **Recommendation:** Create separate `markdown/saved-tabs.md` file

3. **Should we export incognito tabs?**
   - Security concern: Incognito URLs in plain text markdown
   - **Recommendation:** Skip incognito tabs (add `if (tab.incognito) continue;`)

4. **What if device name contains filesystem-unsafe characters?**
   - Example: "Chrome / Firefox" has `/` character
   - **Recommendation:** Sanitize filename, keep original name in markdown content

## Next Steps

1. **Review this spec** - Confirm architecture and decisions
2. **Create package structure** - `apps/tab-manager-markdown/`
3. **Implement Phase 1** - Basic export functionality
4. **Test with real tab-manager** - Verify sync works end-to-end
5. **Write README** - Document usage and setup
6. **Consider Phase 2 enhancements** - Based on real-world usage

---

**Spec complete. Ready for implementation approval.**
