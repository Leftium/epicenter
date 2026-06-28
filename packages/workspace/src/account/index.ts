/**
 * `@epicenter/workspace/account` — the per-person account doc: the device
 * roster (and, from Wave 4, the trust ledger) as one append-only log of
 * device-signed assertions plus a device-local reducer.
 *
 * BROWSER-SAFE by construction. The signing and verification primitive is
 * portable `@noble/ed25519` over raw key bytes, so the same reducer projects the
 * roster in a browser tab, in the daemon, and in a future WASM-iroh peer. iroh
 * stays node-only and transport-only; nothing in this subpath imports it. The
 * node-side wiring that opens the account room over the relay (loading the iroh
 * key file, joining the room) lives in `@epicenter/workspace/node`, not here.
 */

export {
	type Assertion,
	type AssertionVerb,
	AssertionSchema,
	AssertionVerbSchema,
	assertionSigningBytes,
	ACCOUNT_ASSERTION_SIGNING_DOMAIN,
	checkAssertion,
	type UnsignedAssertion,
} from './assertion.js';
export {
	peerIdFromSecret,
	signAssertion,
	verifyAssertionSignature,
} from './crypto.js';
export { type Roster, type RosterEntry, rosterFromAssertions } from './reducer.js';
export {
	ACCOUNT_ASSERTIONS_KEY,
	accountAssertionLog,
	appendIdentityClaim,
	type AppendIdentityClaimOptions,
	type AppendIdentityClaimResult,
	readAssertions,
	readRoster,
} from './account-doc.js';
export { RESERVED_ACCOUNT_ROOM_GUID } from './reserved-guid.js';
