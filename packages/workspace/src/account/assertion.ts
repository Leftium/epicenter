/**
 * The account doc's one wire shape: a device-signed assertion.
 *
 * The account doc is a single append-only log of these; roster, label, and (in
 * Wave 4) trust are all projections a device-local reducer folds out of the log.
 * There is no second, mutable structure. An assertion is a fact one device
 * (`asserter`) states about a peer (`subject`), signed by the asserter's iroh
 * key, so the relay can drop, reorder, or replay an assertion but never forge
 * one (it holds no device secret key).
 *
 * One shape, three verbs:
 *   - `identity` — a self-claim (`asserter == subject`) carrying the device's
 *     `label`. The roster is the fold of the latest valid identity claim per
 *     peer. This is the only verb Wave 3 acts on.
 *   - `verify` / `revoke` — cross-claims about another peer that drive the trust
 *     state in Wave 4. The wire admits them now (forward-compatible: a Wave 3
 *     reader tolerates a doc a Wave 4 writer wrote) but the Wave 3 reducer
 *     ignores them.
 *
 * `seq` is a per-asserter monotonic counter that orders an asserter's own
 * claims (never Yjs's clientID, which is a property of the merge, not the
 * author). `account` binds the assertion to one user, so a replayed or
 * cross-account assertion is rejected by the reducer. There is no `prevHash`
 * (per-asserter `seq` already orders, and the threat model concedes cloud-drop)
 * and no `kind` (dialing is uniform; the label identifies the device).
 *
 * `peerId` is an iroh `EndpointId` in its 64-char lowercase-hex form, which IS
 * the raw 32-byte Ed25519 public key. That is what lets the signature verify in
 * a portable, browser-safe way (see `crypto.ts`): the verifier hex-decodes the
 * `asserter` straight into the public key, with no iroh dependency.
 *
 * Schemas are TypeBox: valid JSON Schema at runtime, the source of truth for the
 * TypeScript types via `Static`, and compiled once into a checked validator the
 * reducer runs over every (untrusted, relay-delivered) log entry before reading
 * a single field.
 */

import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';

/**
 * The verbs an assertion can carry. The wire admits all three from Wave 3 so the
 * log shape is stable across waves; the Wave 3 reducer only acts on `identity`.
 */
export const AssertionVerbSchema = Type.Union([
	Type.Literal('identity'),
	Type.Literal('verify'),
	Type.Literal('revoke'),
]);
export type AssertionVerb = Static<typeof AssertionVerbSchema>;

/**
 * A device-signed assertion: the account doc's sole record type.
 *
 * `asserter` and `subject` are peerIds (64-hex Ed25519 public keys); `sig` is
 * the 128-hex Ed25519 signature over {@link assertionSigningBytes}. `label` is
 * present on an `identity` claim (the device name) and omitted on cross-claims.
 */
export const AssertionSchema = Type.Object({
	/** The user this assertion belongs to; binds the log to one account. */
	account: Type.String(),
	/** The asserting device's peerId (64-hex Ed25519 public key). */
	asserter: Type.String(),
	/** The peer this assertion is about; equals `asserter` for `identity`. */
	subject: Type.String(),
	verb: AssertionVerbSchema,
	/** Per-asserter monotonic counter; orders an asserter's own claims. */
	seq: Type.Integer({ minimum: 0 }),
	/** Device label, present on `identity` claims (hostname by default). */
	label: Type.Optional(Type.String()),
	/** Ed25519 signature (128-hex) over {@link assertionSigningBytes}. */
	sig: Type.String(),
});
export type Assertion = Static<typeof AssertionSchema>;

/**
 * The signable core of an assertion: every field except the signature itself.
 * Signing covers exactly this, so the verifier recomputes it from the stored
 * assertion and checks `sig` against it.
 */
export type UnsignedAssertion = Omit<Assertion, 'sig'>;

/** Pre-compiled validator narrowing an untrusted log entry to an {@link Assertion}. */
export const checkAssertion = Compile(AssertionSchema);

/**
 * Domain-separated, versioned tag mixed into every signed message so a signature
 * minted here can never be replayed as a signature over some other Epicenter
 * payload, and so a future wire revision is a new domain rather than a silent
 * reinterpretation of old bytes.
 */
export const ACCOUNT_ASSERTION_SIGNING_DOMAIN = 'epicenter.account.assertion.v1';

/**
 * The exact bytes an assertion's signature covers.
 *
 * A JSON array in fixed field order (not the object) so the encoding is
 * deterministic and unambiguous: `label` is serialized as `null` when absent,
 * which is distinct from the empty string, and JSON escaping means no field's
 * contents can be mistaken for a separator. Both the signer and the verifier
 * call this, so they can never drift.
 */
export function assertionSigningBytes(unsigned: UnsignedAssertion): Uint8Array {
	const canonical = JSON.stringify([
		ACCOUNT_ASSERTION_SIGNING_DOMAIN,
		unsigned.account,
		unsigned.asserter,
		unsigned.subject,
		unsigned.verb,
		unsigned.seq,
		unsigned.label ?? null,
	]);
	return new TextEncoder().encode(canonical);
}
