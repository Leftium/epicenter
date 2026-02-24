/**
 * Tool definition contracts for AI chat.
 *
 * Uses `toolDefinition()` from TanStack AI with arktype schemas (Standard
 * Schema compatible). Definitions are pure schema contracts with no runtime
 * dependencies — they describe the tool's name, description, and input shape.
 *
 * `.server()` implementations live in read-tools.ts and mutation-tools.ts,
 * which bind these contracts to the BGSW's Y.Doc tables and Chrome APIs.
 *
 * These were previously in `packages/server/src/ai/tools/definitions.ts`.
 * Moved here because they are tab-manager-specific — the hub server no longer
 * needs them after decoupling.
 *
 * @see docs/articles/tanstack-ai-isomorphic-tool-pattern.md
 */

import { toolDefinition } from '@tanstack/ai';
import { type } from 'arktype';

// ─────────────────────────────────────────────────────────────────────────────
// Read Tools (5)
// ─────────────────────────────────────────────────────────────────────────────

export const searchTabsDef = toolDefinition({
	name: 'searchTabs',
	description:
		'Search tabs by URL or title match. Returns matching tabs across all devices, optionally scoped to one device.',
	inputSchema: type({
		query: 'string',
		'deviceId?': 'string',
	}),
});

export const listTabsDef = toolDefinition({
	name: 'listTabs',
	description: 'List all open tabs. Optionally filter by device or window.',
	inputSchema: type({
		'deviceId?': 'string',
		'windowId?': 'string',
	}),
});

export const listWindowsDef = toolDefinition({
	name: 'listWindows',
	description:
		'List all browser windows with their tab counts. Optionally filter by device.',
	inputSchema: type({
		'deviceId?': 'string',
	}),
});

export const listDevicesDef = toolDefinition({
	name: 'listDevices',
	description:
		'List all synced devices with their names, browsers, and online status.',
	inputSchema: type({}),
});

export const countByDomainDef = toolDefinition({
	name: 'countByDomain',
	description:
		'Count open tabs grouped by domain (e.g. youtube.com: 5, github.com: 3). Optionally filter by device.',
	inputSchema: type({
		'deviceId?': 'string',
	}),
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutation Tools (8)
// ─────────────────────────────────────────────────────────────────────────────

export const closeTabsDef = toolDefinition({
	name: 'closeTabs',
	description: 'Close one or more tabs by their composite IDs.',
	inputSchema: type({
		tabIds: 'string[]',
	}),
});

export const openTabDef = toolDefinition({
	name: 'openTab',
	description: 'Open a new tab with the given URL on a specific device.',
	inputSchema: type({
		url: 'string',
		deviceId: 'string',
		'windowId?': 'string',
	}),
});

export const activateTabDef = toolDefinition({
	name: 'activateTab',
	description: 'Activate (focus) a specific tab by its composite ID.',
	inputSchema: type({
		tabId: 'string',
	}),
});

export const saveTabsDef = toolDefinition({
	name: 'saveTabs',
	description: 'Save tabs for later. Optionally close them after saving.',
	inputSchema: type({
		tabIds: 'string[]',
		'close?': 'boolean',
	}),
});

export const groupTabsDef = toolDefinition({
	name: 'groupTabs',
	description: 'Group tabs together with an optional title and color.',
	inputSchema: type({
		tabIds: 'string[]',
		'title?': 'string',
		'color?': 'string',
	}),
});

export const pinTabsDef = toolDefinition({
	name: 'pinTabs',
	description: 'Pin or unpin tabs.',
	inputSchema: type({
		tabIds: 'string[]',
		pinned: 'boolean',
	}),
});

export const muteTabsDef = toolDefinition({
	name: 'muteTabs',
	description: 'Mute or unmute tabs.',
	inputSchema: type({
		tabIds: 'string[]',
		muted: 'boolean',
	}),
});

export const reloadTabsDef = toolDefinition({
	name: 'reloadTabs',
	description: 'Reload one or more tabs.',
	inputSchema: type({
		tabIds: 'string[]',
	}),
});
