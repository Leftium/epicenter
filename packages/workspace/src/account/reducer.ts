/**
 * The device-local reducer: fold the signed-assertion log into the roster.
 *
 * This is where authority lives. The account Y.Doc is relayed in plaintext
 * (ADR-0004), so the cloud can drop, reorder, replay, or corrupt the log, but
 * every entry is signed by the asserting device's key. The reducer verifies each
 * signature locally and ignores anything that does not check out, so a
 * cloud-injected entry never reaches a projection. The relay owns replication;
 * the reducer owns trust.
 *
 * Wave 3 folds out exactly one projection, the ROSTER: the latest valid
 * self-signed `identity` claim per peer, keyed by peerId, carrying the device
 * label. The trust state (`listed | verified | revoked`) is a Wave 4 addition to
 * this same fold over the same log, not a rewrite.
 *
 * Ordering is by each asserter's own monotonic `seq`, never by Yjs's clientID
 * (which records merge order, not authorship): the highest-`seq` valid identity
 * claim per peer wins, so a device renaming itself simply appends a
 * higher-`seq` claim.
 *
 * Pure and browser-safe: it takes the raw log array and the expected account,
 * and returns a plain Map. It pulls in no Yjs, no iroh, no node built-in, only
 * the portable signature check.
 */

import { asPeerId, type PeerId } from '../peer-transport.js';
import { type Assertion, checkAssertion } from './assertion.js';
import { verifyAssertionSignature } from './crypto.js';

/** One peer's entry in the roster projection: its current device label. */
export type RosterEntry = {
	/** The device's human-facing label (hostname by default). */
	label: string;
};

/** The roster projection: every dialable peer this account has listed. */
export type Roster = ReadonlyMap<PeerId, RosterEntry>;

/**
 * Fold a raw assertion log into the roster.
 *
 * `rawEntries` is the account doc's append-only array, untrusted: each entry is
 * shape-checked, account-bound, and signature-verified before it can influence
 * the result. `account` is the signed-in user's id; an assertion for any other
 * account is ignored, so a replayed cross-account log cannot inject a peer.
 *
 * An entry survives into the roster only if it is a well-formed assertion, bound
 * to `account`, an `identity` verb (Wave 3 ignores `verify`/`revoke`),
 * self-signed (`asserter == subject`, the definition of an identity claim), and
 * carries a valid signature by that peer's own key. Among the survivors for a
 * peer, the highest `seq` wins.
 */
export function rosterFromAssertions(
	rawEntries: readonly unknown[],
	account: string,
): Roster {
	// Track the winning seq per peer so a later, lower-seq replay cannot displace
	// a device's current label.
	const winners = new Map<PeerId, { seq: number; label: string }>();

	for (const raw of rawEntries) {
		if (!checkAssertion.Check(raw)) continue;
		const assertion = raw as Assertion;

		if (assertion.account !== account) continue; // cross-account: not ours
		if (assertion.verb !== 'identity') continue; // Wave 3: roster only
		if (assertion.asserter !== assertion.subject) continue; // not a self-claim
		if (!verifyAssertionSignature(assertion)) continue; // unsigned / forged

		const peerId = asPeerId(assertion.subject);
		const existing = winners.get(peerId);
		if (existing && existing.seq >= assertion.seq) continue;

		winners.set(peerId, {
			seq: assertion.seq,
			label: assertion.label ?? assertion.subject,
		});
	}

	const roster = new Map<PeerId, RosterEntry>();
	for (const [peerId, { label }] of winners) roster.set(peerId, { label });
	return roster;
}

/**
 * A peer's effective trust, the second projection the same log folds out.
 *
 *   - `listed` — a peer with a valid self-signed identity claim and no `verify`
 *     from a trusted asserter. It is dialable and named, but no human has
 *     confirmed it.
 *   - `verified` — a peer a trusted asserter has signed a `verify` for (or the
 *     gateway's own key, the root of trust).
 *   - `revoked` — a peer a trusted asserter has signed a `revoke` for. Revocation
 *     is absolute: a revoked peer meets no route threshold.
 *
 * Whether a tool ACCEPTS a merely-`listed` peer is a per-route sensitivity policy
 * on the gateway, not a trust level here (see `gateway/route-table.ts`). This
 * keeps the discovery line (who exists) and the authority line (who is confirmed)
 * from blurring back together.
 */
export type TrustState = 'listed' | 'verified' | 'revoked';

/** The highest-seq verify/revoke verdict one asserter has stated about a subject. */
type Verdict = { seq: number; verb: 'verify' | 'revoke' };

/**
 * Fold the log into per-peer trust state, rooted in `selfPeerId`.
 *
 * The root of trust is `selfPeerId` plus the devices it has DIRECTLY paired with
 * (devices `selfPeerId` itself signed a still-current `verify` for). Trust is
 * bounded to depth 1: a device that a directly-paired device verified is NOT
 * itself a trusted asserter, so there is no transitive web-of-trust in v1. A
 * `verify` or `revoke` signed by anyone outside this root set is ignored, exactly
 * like a cloud-injected entry, so the cloud can never mint an authority
 * transition.
 *
 * Ordering is by each asserter's own `seq`: the highest-seq verdict per
 * (asserter, subject) wins, so a `revoke` at a higher seq supersedes an earlier
 * `verify`, and only a strictly-greater-seq signed re-`verify` resurrects the
 * peer (a replayed lower-or-equal-seq verify cannot). Across asserters, a
 * `revoke` from any trusted asserter wins over a `verify` from another: revocation
 * is the safe direction for one person's own fleet.
 *
 * Pure and browser-safe like {@link rosterFromAssertions}: raw log in, plain Map
 * out, no Yjs and no iroh.
 */
export function trustFromAssertions(
	rawEntries: readonly unknown[],
	account: string,
	selfPeerId: PeerId,
): ReadonlyMap<PeerId, TrustState> {
	// Highest-seq verify/revoke verdict per (asserter, subject). Identity claims
	// are the roster's job; here we only fold the cross-claims that carry
	// authority, and only after the same shape/account/signature gate.
	const verdicts = new Map<PeerId, Map<PeerId, Verdict>>();
	for (const raw of rawEntries) {
		if (!checkAssertion.Check(raw)) continue;
		const assertion = raw as Assertion;

		if (assertion.account !== account) continue;
		if (assertion.verb !== 'verify' && assertion.verb !== 'revoke') continue;
		if (!verifyAssertionSignature(assertion)) continue;

		const asserter = asPeerId(assertion.asserter);
		const subject = asPeerId(assertion.subject);
		let bySubject = verdicts.get(asserter);
		if (!bySubject) verdicts.set(asserter, (bySubject = new Map()));
		const existing = bySubject.get(subject);
		if (existing && existing.seq >= assertion.seq) continue; // replay / older
		bySubject.set(subject, { seq: assertion.seq, verb: assertion.verb });
	}

	// The root of trust: self, plus every device self has a CURRENT verify for.
	// `revoke`-supersedes-`verify` already collapsed above, so a pair self has
	// since revoked is absent here. Depth stops at 1: these asserters' verdicts
	// confer trust, but the peers THEY verify do not become asserters in turn.
	const trustedAsserters = new Set<PeerId>([selfPeerId]);
	for (const [subject, verdict] of verdicts.get(selfPeerId) ?? []) {
		if (verdict.verb === 'verify') trustedAsserters.add(subject);
	}

	// Every peer that could carry a state: anything in the roster (so an
	// unverified device reads `listed`) plus any subject a trusted asserter ruled
	// on (so a revoke of a not-yet-listed device still reads `revoked`).
	const roster = rosterFromAssertions(rawEntries, account);
	const subjects = new Set<PeerId>(roster.keys());
	for (const asserter of trustedAsserters) {
		for (const subject of verdicts.get(asserter)?.keys() ?? []) {
			subjects.add(subject);
		}
	}

	const states = new Map<PeerId, TrustState>();
	for (const subject of subjects) {
		let revoked = false;
		let verified = false;
		for (const asserter of trustedAsserters) {
			const verdict = verdicts.get(asserter)?.get(subject);
			if (!verdict) continue;
			if (verdict.verb === 'revoke') {
				revoked = true;
				break; // a revoke from any trusted asserter is final
			}
			verified = true;
		}
		states.set(subject, revoked ? 'revoked' : verified ? 'verified' : 'listed');
	}

	// Self is the root of trust: it always trusts its own key, even before it has
	// listed itself or if a peer tried to revoke it.
	states.set(selfPeerId, 'verified');
	return states;
}
