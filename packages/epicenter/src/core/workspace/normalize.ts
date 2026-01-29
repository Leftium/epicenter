/**
 * Normalization utilities and type guards.
 *
 * This module provides:
 * - Icon normalization (string → Icon tagged string)
 * - Type guards for KV and Table definitions
 * - Default icon constants
 *
 * Note: KV and Table normalization has been removed. Both now require explicit
 * metadata via the `setting()` and `table()` helpers respectively.
 *
 * @module
 */

import type { Icon, KvField, TableDefinition } from '../schema';
import { isIcon } from '../schema';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default icon for KV entries when using minimal input.
 */
export const DEFAULT_KV_ICON: Icon = 'emoji:⚙️';

// ─────────────────────────────────────────────────────────────────────────────
// Icon Normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize icon input to Icon | null.
 *
 * - Icon string (tagged format) → unchanged
 * - Plain emoji string → converted to 'emoji:{value}'
 * - undefined → null
 * - null → null
 *
 * @example
 * ```typescript
 * normalizeIcon('emoji:📝');     // 'emoji:📝' (unchanged)
 * normalizeIcon('📝');           // 'emoji:📝' (converted)
 * normalizeIcon('lucide:file');  // 'lucide:file' (unchanged)
 * normalizeIcon(undefined);      // null
 * normalizeIcon(null);           // null
 * ```
 */
export function normalizeIcon(
	icon: string | Icon | null | undefined,
): Icon | null {
	if (icon === undefined || icon === null) return null;
	if (isIcon(icon)) return icon;
	// Plain string (emoji) → convert to tagged format
	return `emoji:${icon}` as Icon;
}

// ─────────────────────────────────────────────────────────────────────────────
// Type Guards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a value is a TableDefinition.
 *
 * Detection: TableDefinition has `fields` and `name` properties.
 *
 * @example
 * ```typescript
 * const tableDef = table('posts', { name: 'Posts', fields: [id()] });
 * isTableDefinition(tableDef); // true
 *
 * const notTable = { id: id(), title: text() };
 * isTableDefinition(notTable); // false
 * ```
 */
export function isTableDefinition(value: unknown): value is TableDefinition {
	return (
		typeof value === 'object' &&
		value !== null &&
		'fields' in value &&
		'name' in value
	);
}

/**
 * Check if a KV value is a full KvDefinition (has metadata wrapper).
 *
 * Detection: KvDefinition has `field` and `name` properties.
 *
 * @deprecated KvDefinition is deprecated. Use KvField directly (field's id serves as key).
 *
 * @example
 * ```typescript
 * const kv = select({ options: ['light', 'dark'] });
 * isKvDefinition(kv); // false
 *
 * const kvDef = { name: 'Theme', icon: null, description: '', field: select({ options: ['light', 'dark'] }) };
 * isKvDefinition(kvDef); // true
 * ```
 */
export function isKvDefinition(
	value: unknown,
): value is { name: string; field: KvField } {
	return (
		typeof value === 'object' &&
		value !== null &&
		'field' in value &&
		'name' in value
	);
}
