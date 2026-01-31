/**
 * @fileoverview Rich content ID generation utilities
 *
 * Provides ID generation for rich content documents. These IDs are stored in
 * richtext() columns and reference separate Y.Doc instances for collaborative editing.
 */

import { customAlphabet } from 'nanoid';
import type { Brand } from 'wellcrafted/brand';

/**
 * Rich content ID type - branded string with "rtxt_" prefix
 *
 * These IDs reference separate Y.Doc instances that contain the actual
 * collaborative content (Y.Text, Y.XmlFragment, etc.).
 *
 * @see {@link createRichContentId}
 */
export type RichContentId = `rtxt_${string}` & Brand<'RichContentId'>;

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);

/**
 * Generates a unique ID for rich content documents.
 *
 * The ID follows the format "rtxt_{nanoid}" where nanoid is a 12-character
 * alphanumeric string. This prefix makes rich content IDs easily identifiable
 * in logs, databases, and debugging.
 *
 * Use this when:
 * - Creating a new row with a richtext() column
 * - Initializing collaborative content for the first time
 *
 * @returns Unique rich content identifier (e.g., "rtxt_abc123xyz789")
 *
 * @example
 * ```typescript
 * // Creating a new post with rich content
 * const contentId = createRichContentId();
 * tables.get('posts').upsert({
 *   id: generateId(),
 *   title: 'My Post',
 *   content: contentId,  // richtext() column stores this ID
 * });
 *
 * // Later, the Y.Doc for this content is accessed via:
 * // getRichContentDoc(contentId)
 * ```
 */
export function createRichContentId(): RichContentId {
	return `rtxt_${nanoid()}` as RichContentId;
}
