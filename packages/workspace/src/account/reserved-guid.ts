/**
 * The reserved guid of the per-person account room.
 *
 * The account room (the per-user fleet room the relay floor rides) is not a new
 * Durable Object type: it is an ordinary sync room opened at
 * `owners/<userId>/rooms/<RESERVED_ACCOUNT_ROOM_GUID>`, so it reuses every bit
 * of room machinery (bearer auth, Y.Doc sync, the WebSocket upgrade). What makes
 * it safe to reserve a fixed guid is that it cannot collide with any guid a user
 * workspace mints:
 *
 *   - A workspace ROOT guid is a single {@link assertSafeSegment} segment, so it
 *     contains no dot (`epicenter-fuji`).
 *   - A content-doc guid is exactly four dotted segments
 *     (`workspace.collection.row.field`, see `document/doc-guid.ts`).
 *
 * This guid is two dotted segments (`epicenter.account`), a shape neither
 * minting path can ever produce. Each segment still passes the safe-segment
 * grammar (validated below at module load), so the guid is safe in every sink a
 * guid feeds (URL path, on-disk `<guid>.db`, IndexedDB store). The relay itself
 * is guid-grammar-blind: Hono treats `.` as a literal and a single `:roomId`
 * param captures the whole dotted id, so a dotted guid round-trips the route
 * unchanged (`rooms-route-pattern.test.ts`).
 */

import { assertSafeSegment } from '../shared/safe-segment.js';

/**
 * The fixed room guid every device opens to reach its owner's account doc. Two
 * dotted safe segments: structurally distinct from both a one-segment workspace
 * root and a four-segment content doc, so it can never collide with user data.
 */
export const RESERVED_ACCOUNT_ROOM_GUID = 'epicenter.account';

// Fail loud at import time if the reserved guid ever drifts to a value whose
// segments are not individually safe. Cheap insurance: the constant is a literal
// today, but this keeps the collision-free + every-sink-safe property honest.
for (const segment of RESERVED_ACCOUNT_ROOM_GUID.split('.')) {
	assertSafeSegment(segment, 'account room guid segment');
}
