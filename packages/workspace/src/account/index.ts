/**
 * `@epicenter/workspace/account` — the per-person account room's reserved guid.
 *
 * The account room is the per-user fleet room the relay floor rides (see
 * `daemon/open-account-room.ts`): an ordinary sync room at a fixed guid, no
 * Durable Object of its own. It carries no device roster or trust ledger; the
 * relay floor authenticates by the session's `userId`, so all that survives here
 * is the reserved guid the room opens at.
 */

export { RESERVED_ACCOUNT_ROOM_GUID } from './reserved-guid.js';
