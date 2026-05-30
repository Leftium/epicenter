import type { Guid } from '../shared/id.js';
import { assertSafeSegment } from '../shared/safe-segment.js';

/**
 * Compose a content-doc `Y.Doc` guid in the canonical 4-part dotted form:
 *
 *   `${workspaceId}.${collection}.${rowId}.${field}`
 *
 * | Segment       | Owner       | Example          |
 * |---------------|-------------|------------------|
 * | `workspaceId` | caller      | `epicenter-fuji` |
 * | `collection`  | package/app | `entries`, `files` |
 * | `rowId`       | caller      | `k7x9m2p4q8`     |
 * | `field`       | package/app | `content`, `body` |
 *
 * Every part is validated against {@link assertSafeSegment}, so each is a
 * single dot-free safe segment. That is what makes this composition injective:
 * because `collection`, `rowId`, and `field` contain no dots, the three
 * trailing segments are recoverable from the right, and no two distinct
 * `(workspaceId, collection, rowId, field)` tuples can ever produce the same
 * guid. A collision here would merge two Y.Docs, so the guarantee is load
 * bearing, not cosmetic.
 *
 * Using this helper (instead of inline template literals) keeps the grammar
 * in one place and the validation impossible to forget.
 */
export const docGuid = ({
	workspaceId,
	collection,
	rowId,
	field,
}: {
	workspaceId: string;
	collection: string;
	rowId: string;
	field: string;
}): Guid => {
	assertSafeSegment(workspaceId, 'workspaceId');
	assertSafeSegment(collection, 'collection');
	assertSafeSegment(rowId, 'rowId');
	assertSafeSegment(field, 'field');
	return `${workspaceId}.${collection}.${rowId}.${field}` as Guid;
};
