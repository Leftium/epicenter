/**
 * Composite ID types, constructors, and parsers for multi-device tab sync.
 *
 * All browser entity IDs (tabs, windows, groups) are scoped to a device:
 * `${deviceId}_${nativeId}`. This module provides branded types for type safety,
 * arktype validators for runtime validation, and parse/create helpers.
 */

import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

// ─────────────────────────────────────────────────────────────────────────────
// Branded Composite ID Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Device-scoped composite tab ID: `${deviceId}_${tabId}`.
 *
 * Prevents accidental mixing with plain strings, window IDs, or group IDs.
 *
 * @example
 * ```typescript
 * // As a type annotation
 * function getTab(id: TabCompositeId): Tab { ... }
 *
 * // As a runtime validator (arktype schema) in table definitions
 * const tabs = defineTable(type({ id: TabCompositeId, ... }));
 *
 * // To construct a new composite ID, use createTabCompositeId
 * const id = createTabCompositeId(deviceId, 123);
 * ```
 */
export type TabCompositeId = string & Brand<'TabCompositeId'>;
export const TabCompositeId = type('string').pipe(
	(s): TabCompositeId => s as TabCompositeId,
);

/**
 * Device-scoped composite window ID: `${deviceId}_${windowId}`.
 *
 * Prevents accidental mixing with plain strings, tab IDs, or group IDs.
 *
 * @example
 * ```typescript
 * // As a type annotation
 * function getWindow(id: WindowCompositeId): Window { ... }
 *
 * // As a runtime validator (arktype schema) in table definitions
 * const windows = defineTable(type({ id: WindowCompositeId, ... }));
 *
 * // To construct a new composite ID, use createWindowCompositeId
 * const id = createWindowCompositeId(deviceId, 456);
 * ```
 */
export type WindowCompositeId = string & Brand<'WindowCompositeId'>;
export const WindowCompositeId = type('string').pipe(
	(s): WindowCompositeId => s as WindowCompositeId,
);

/**
 * Device-scoped composite group ID: `${deviceId}_${groupId}`.
 *
 * Prevents accidental mixing with plain strings, tab IDs, or window IDs.
 *
 * @example
 * ```typescript
 * // As a type annotation
 * function getGroup(id: GroupCompositeId): TabGroup { ... }
 *
 * // As a runtime validator (arktype schema) in table definitions
 * const tabGroups = defineTable(type({ id: GroupCompositeId, ... }));
 *
 * // To construct a new composite ID, use createGroupCompositeId
 * const id = createGroupCompositeId(deviceId, 789);
 * ```
 */
export type GroupCompositeId = string & Brand<'GroupCompositeId'>;
export const GroupCompositeId = type('string').pipe(
	(s): GroupCompositeId => s as GroupCompositeId,
);

// ─────────────────────────────────────────────────────────────────────────────
// Composite ID Constructors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a device-scoped composite tab ID: `${deviceId}_${tabId}`.
 *
 * Use this whenever you need to construct a {@link TabCompositeId} from its parts.
 * The resulting ID is branded to prevent accidental mixing with other ID types.
 *
 * @example
 * ```typescript
 * const id = createTabCompositeId(deviceId, 123);
 * // "abc123_123" as TabCompositeId
 *
 * tables.tabs.delete(createTabCompositeId(deviceId, tabId));
 * ```
 */
export function createTabCompositeId(
	deviceId: string,
	tabId: number,
): TabCompositeId {
	return `${deviceId}_${tabId}` as TabCompositeId;
}

/**
 * Create a device-scoped composite window ID: `${deviceId}_${windowId}`.
 *
 * Use this whenever you need to construct a {@link WindowCompositeId} from its parts.
 * The resulting ID is branded to prevent accidental mixing with other ID types.
 *
 * @example
 * ```typescript
 * const id = createWindowCompositeId(deviceId, 456);
 * // "abc123_456" as WindowCompositeId
 *
 * tables.windows.delete(createWindowCompositeId(deviceId, windowId));
 * ```
 */
export function createWindowCompositeId(
	deviceId: string,
	windowId: number,
): WindowCompositeId {
	return `${deviceId}_${windowId}` as WindowCompositeId;
}

/**
 * Create a device-scoped composite group ID: `${deviceId}_${groupId}`.
 *
 * Use this whenever you need to construct a {@link GroupCompositeId} from its parts.
 * The resulting ID is branded to prevent accidental mixing with other ID types.
 *
 * @example
 * ```typescript
 * const id = createGroupCompositeId(deviceId, 789);
 * // "abc123_789" as GroupCompositeId
 *
 * tables.tabGroups.delete(createGroupCompositeId(deviceId, groupId));
 * ```
 */
export function createGroupCompositeId(
	deviceId: string,
	groupId: number,
): GroupCompositeId {
	return `${deviceId}_${groupId}` as GroupCompositeId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite ID Parsers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Internal helper to parse a composite ID.
 */
function parseCompositeIdInternal(
	compositeId: string,
): { deviceId: string; nativeId: number } | null {
	const idx = compositeId.indexOf('_');
	if (idx === -1) return null;

	const deviceId = compositeId.slice(0, idx);
	const nativeId = Number.parseInt(compositeId.slice(idx + 1), 10);

	if (Number.isNaN(nativeId)) return null;

	return { deviceId, nativeId };
}

/**
 * Parse a composite tab ID into its parts.
 * @example parseTabId('abc123_456') // { deviceId: 'abc123', tabId: 456 }
 */
export function parseTabId(
	compositeId: TabCompositeId,
): { deviceId: string; tabId: number } | null {
	const result = parseCompositeIdInternal(compositeId);
	if (!result) return null;
	return { deviceId: result.deviceId, tabId: result.nativeId };
}

/**
 * Parse a composite window ID into its parts.
 * @example parseWindowId('abc123_456') // { deviceId: 'abc123', windowId: 456 }
 */
export function parseWindowId(
	compositeId: WindowCompositeId,
): { deviceId: string; windowId: number } | null {
	const result = parseCompositeIdInternal(compositeId);
	if (!result) return null;
	return { deviceId: result.deviceId, windowId: result.nativeId };
}

/**
 * Parse a composite group ID into its parts.
 * @example parseGroupId('abc123_456') // { deviceId: 'abc123', groupId: 456 }
 */
export function parseGroupId(
	compositeId: GroupCompositeId,
): { deviceId: string; groupId: number } | null {
	const result = parseCompositeIdInternal(compositeId);
	if (!result) return null;
	return { deviceId: result.deviceId, groupId: result.nativeId };
}
