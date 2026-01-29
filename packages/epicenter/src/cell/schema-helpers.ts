/**
 * Schema Helper Functions
 *
 * Factory functions for creating cell schema types with sensible defaults.
 *
 * NOTE: For most use cases, prefer using the core factory function
 * `table()` from `../core/schema/fields/factories`.
 * These cell-specific helpers are for JSON parsing scenarios.
 */

import type { Field, Icon } from '../core/schema/fields/types';
import { isIcon } from '../core/schema/fields/types';
import type { SchemaFieldDefinition, SchemaTableDefinition } from './types';

/**
 * Normalize icon input to Icon | null.
 */
function normalizeIcon(icon: string | Icon | null | undefined): Icon | null {
	if (icon === undefined || icon === null) return null;
	if (isIcon(icon)) return icon;
	return `emoji:${icon}` as Icon;
}

/**
 * Create a SchemaTableDefinition with sensible defaults.
 *
 * For most use cases, prefer the core `table()` factory which provides
 * better type inference. This function is useful for JSON parsing.
 *
 * Accepts Record-based fields input and converts to array-based output.
 *
 * @example
 * ```ts
 * const posts = schemaTable('posts', {
 *   name: 'Posts',
 *   fields: {
 *     id: id(),
 *     title: text({ name: 'Title' }),
 *   },
 * });
 * ```
 */
export function schemaTable(
	tableId: string,
	options: {
		name: string;
		fields: Record<string, Field>;
		description?: string;
		icon?: string | Icon | null;
	},
): SchemaTableDefinition {
	// Convert Record-based fields to array with id property
	const fieldsArray: SchemaFieldDefinition[] = Object.entries(
		options.fields,
	).map(([fieldId, field]) => ({ ...field, id: fieldId }));

	return {
		id: tableId,
		name: options.name,
		description: options.description ?? '',
		icon: normalizeIcon(options.icon),
		fields: fieldsArray,
	};
}
