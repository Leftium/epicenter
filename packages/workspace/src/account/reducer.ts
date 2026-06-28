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

import { asPeerId, type PeerId } from '../gateway/transport.js';
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
