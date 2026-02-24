/**
 * Tool definition contracts for AI chat.
 *
 * Uses `toolDefinition()` from TanStack AI with arktype schemas (Standard
 * Schema compatible). Definitions are pure schema contracts with no runtime
 * dependencies — they describe the tool's name, description, and input shape.
 *
 * `.client()` implementations live in `client.ts`, which bind these contracts
 * to the sidebar's Y.Doc tables and Chrome APIs.
 *
 * @see docs/articles/tanstack-ai-isomorphic-tool-pattern.md
 * @see https://github.com/TanStack/ai/issues/276 — arktype `typeof` bug in convertSchemaToJsonSchema
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
	description: 'Open a new tab with the given URL on the current device.',
	inputSchema: type({
		url: 'string',
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

// ─────────────────────────────────────────────────────────────────────────────
// All Definitions (for passing schemas to server in request body)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All tool definitions as an array.
 *
 * Used for `.client(execute)` in client.ts — ChatClient auto-execution.
 */
export const allToolDefinitions = [
	searchTabsDef,
	listTabsDef,
	listWindowsDef,
	listDevicesDef,
	countByDomainDef,
	closeTabsDef,
	openTabDef,
	activateTabDef,
	saveTabsDef,
	groupTabsDef,
	pinTabsDef,
	muteTabsDef,
	reloadTabsDef,
];

/**
 * Tool definitions with arktype schemas pre-converted to JSON Schema.
 *
 * We use arktype's native `.toJsonSchema()` instead of TanStack AI's
 * `convertSchemaToJsonSchema` because arktype types are callable functions
 * (`typeof` → `'function'`), and TanStack AI's Standard JSON Schema
 * detection checks `typeof schema === 'object'` — which fails for arktype.
 *
 * @see https://github.com/TanStack/ai/issues/276
 * @see https://arktype.io/docs/type-api#tojsonschema
 */
export const allServerToolDefinitions = allToolDefinitions.map((def) => ({
	name: def.name,
	description: def.description,
	...(def.inputSchema ? { inputSchema: def.inputSchema.toJsonSchema() } : {}),
}));
