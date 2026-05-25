import { toSlugFilename } from '../../../markdown/to-slug-filename.js';
import type { BaseRow } from '../../attach-table.js';

/**
 * Build a `filename` slot that produces `{slug}-{id}.md` using a row field
 * as the slug source. Pass via `perTable[tableName].filename`.
 *
 * @example
 * ```typescript
 * attachMarkdownMaterializer(ydoc, {
 *   dir,
 *   tables,
 *   perTable: { posts: { filename: slugFilename('title') } },
 * });
 * // row with title "Hello World", id "abc123" => "hello-world-abc123.md"
 * ```
 */
export function slugFilename<TField extends string>(field: TField) {
	return <TRow extends BaseRow & { [P in TField]: unknown }>(
		row: TRow,
	): string => {
		const value = row[field];
		return toSlugFilename(
			typeof value === 'string' ? value : undefined,
			String(row.id),
		);
	};
}
