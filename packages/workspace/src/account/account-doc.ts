/**
 * The account doc's one structure and the operations over it.
 *
 * The doc holds a single append-only `Y.Array` of signed assertions under one
 * key. Everything else (the roster today, trust tomorrow) is a reducer
 * projection, never a second stored structure, so the doc cannot hold two facts
 * about a device that disagree.
 *
 * These helpers are browser-safe: they take a `Y.Doc` and raw key bytes and do
 * the Yjs reads/writes plus the portable sign step. The node side (loading the
 * iroh key file, opening the room over the relay) lives in
 * `daemon/open-account-room.ts`; nothing here imports iroh or a node built-in.
 */

import type * as Y from 'yjs';
import type { PeerId } from '../gateway/transport.js';
import {
	type Assertion,
	checkAssertion,
	type UnsignedAssertion,
} from './assertion.js';
import {
	peerIdFromSecret,
	signAssertion,
	verifyAssertionSignature,
} from './crypto.js';
import { type Roster, rosterFromAssertions } from './reducer.js';

/** The Y.Doc key under which the append-only assertion log lives. */
export const ACCOUNT_ASSERTIONS_KEY = 'assertions';

/**
 * The assertion log as a `Y.Array`. The entries are plain JSON objects (so they
 * sync as ordinary CRDT array items); their authenticity comes from the
 * embedded signature, not from any Yjs property. Typed as `Assertion` for the
 * writer's convenience, but every reader treats the contents as untrusted and
 * re-validates (see {@link rosterFromAssertions}).
 */
export function accountAssertionLog(ydoc: Y.Doc): Y.Array<Assertion> {
	return ydoc.getArray<Assertion>(ACCOUNT_ASSERTIONS_KEY);
}

/** Read the raw log as a plain array. Entries are untrusted until verified. */
export function readAssertions(ydoc: Y.Doc): Assertion[] {
	return accountAssertionLog(ydoc).toArray();
}

/** Fold the doc's log into the roster for `account`. */
export function readRoster(ydoc: Y.Doc, account: string): Roster {
	return rosterFromAssertions(readAssertions(ydoc), account);
}

/**
 * The highest `seq` this peer has itself validly claimed, or `null` if it has
 * never appended a verifiable identity claim.
 *
 * Counts only entries that verify under the peer's own key, so a cloud-injected
 * high-`seq` entry forged in the peer's name (it cannot sign one) does not push
 * the counter forward. The next claim uses `seq = (this ?? -1) + 1`, which is
 * strictly greater than any claim the device has actually made, so it wins the
 * reducer's highest-`seq` rule.
 */
function highestSelfSeq(
	rawEntries: readonly unknown[],
	account: string,
	selfPeerId: PeerId,
): number | null {
	let highest: number | null = null;
	for (const raw of rawEntries) {
		if (!checkAssertion.Check(raw)) continue;
		const assertion = raw as Assertion;
		if (assertion.account !== account) continue;
		if (assertion.verb !== 'identity') continue;
		if (assertion.asserter !== selfPeerId) continue;
		if (assertion.subject !== selfPeerId) continue;
		if (!verifyAssertionSignature(assertion)) continue;
		if (highest === null || assertion.seq > highest) highest = assertion.seq;
	}
	return highest;
}

/** Inputs to {@link appendIdentityClaim}. */
export type AppendIdentityClaimOptions = {
	ydoc: Y.Doc;
	/** The signed-in user id; binds the claim to this account. */
	account: string;
	/** The device's 32-byte iroh secret seed (`SecretKey.toBytes()`). */
	secretKeyBytes: Uint8Array;
	/** The device label to publish (hostname by default). */
	label: string;
};

/** The outcome of {@link appendIdentityClaim}. */
export type AppendIdentityClaimResult = {
	/** This device's peerId (derived from its key). */
	peerId: PeerId;
	/** `true` if a new claim was appended, `false` if the label was unchanged. */
	appended: boolean;
};

/**
 * Append this device's self-signed `identity` claim, idempotently.
 *
 * The roster is the fold of the latest valid identity claim per peer, so a
 * device announces itself by appending one. This is idempotent on the label: if
 * the device's current roster label already equals `label`, it appends nothing
 * (no churn on every daemon restart). Renaming the device (a different `label`)
 * appends a fresh claim at a strictly higher `seq`, which supersedes the old one
 * in the reducer.
 *
 * The append is signed with the very key the device dials with, so the entry is
 * cloud-unforgeable from the moment it lands.
 */
export function appendIdentityClaim(
	options: AppendIdentityClaimOptions,
): AppendIdentityClaimResult {
	const { ydoc, account, secretKeyBytes, label } = options;
	const peerId = peerIdFromSecret(secretKeyBytes);

	const raw = readAssertions(ydoc);
	const currentLabel = rosterFromAssertions(raw, account).get(peerId)?.label;
	if (currentLabel === label) return { peerId, appended: false };

	const unsigned: UnsignedAssertion = {
		account,
		asserter: peerId,
		subject: peerId,
		verb: 'identity',
		seq: (highestSelfSeq(raw, account, peerId) ?? -1) + 1,
		label,
	};
	accountAssertionLog(ydoc).push([signAssertion(unsigned, secretKeyBytes)]);
	return { peerId, appended: true };
}
