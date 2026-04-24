/**
 * Resolve a `--peer <target>` flag against a map of awareness states.
 *
 * Two modes (no overlap):
 *   - all digits        → `clientID` lookup (numeric)
 *   - contains '='      → `<field>=<value>` (split on first '=')
 *
 * The CLI assumes no field-name convention. Bundles that want stable
 * addressing publish a field they chose (`deviceName`, `hostname`, `userId`,
 * …) and callers name it explicitly on the command line.
 *
 * `k=v` mode tries exact first, then falls back to case-insensitive
 * substring. Miss shapes:
 *   - unique substring hit                       → `case-suggest`
 *   - multiple exact or substring hits           → `case-ambiguous`
 *   - otherwise                                  → `not-found`
 *
 * "Case-insensitive" here means the lowercased target appears as a substring
 * of the lowercased peer value — so `deviceName=mymacbook` suggests
 * `myMacbook`, and `deviceName=MACBOOK` reports both `myMacbook` and
 * `workMacbook` as ambiguous.
 *
 * Numeric mode has no fuzzy fallback — a missing clientID is just `not-found`.
 *
 * Edge: `--peer key=val=with=equals` splits on the first '='. A purely
 * numeric target always routes to clientID mode; to match a string field
 * whose value happens to be digits, use `--peer field=42`.
 */
import type { AwarenessState } from './handle-attachments';

export type FindPeerResult =
	| { kind: 'found'; clientID: number; state: AwarenessState }
	| { kind: 'case-suggest'; actual: string; clientID: number }
	| {
			kind: 'case-ambiguous';
			matches: Array<{ value: string; clientID: number }>;
	  }
	| { kind: 'not-found' };

export function findPeer(
	target: string,
	peers: Map<number, AwarenessState>,
): FindPeerResult {
	// Mode 1 — all digits → clientID
	if (/^\d+$/.test(target)) {
		const clientID = Number(target);
		const state = peers.get(clientID);
		if (state !== undefined) return { kind: 'found', clientID, state };
		return { kind: 'not-found' };
	}

	// Mode 2 — `k=v` → explicit field match
	const eq = target.indexOf('=');
	if (eq !== -1) {
		const field = target.slice(0, eq);
		const value = target.slice(eq + 1);
		return matchField(field, value, peers);
	}

	return { kind: 'not-found' };
}

type FieldHit = { value: string; clientID: number; state: AwarenessState };

function matchField(
	field: string,
	value: string,
	peers: Map<number, AwarenessState>,
): FindPeerResult {
	const exact: FieldHit[] = [];
	const caseMatches: FieldHit[] = [];
	const needle = value.toLowerCase();

	for (const [clientID, state] of peers) {
		const raw = state[field];
		if (typeof raw !== 'string') continue;
		if (raw === value) exact.push({ value: raw, clientID, state });
		else if (raw.toLowerCase().includes(needle))
			caseMatches.push({ value: raw, clientID, state });
	}

	if (exact.length === 1) {
		const hit = exact[0]!;
		return { kind: 'found', clientID: hit.clientID, state: hit.state };
	}
	if (exact.length > 1) {
		return { kind: 'case-ambiguous', matches: exact.sort(byClientID).map(stripState) };
	}

	if (caseMatches.length === 1) {
		const hit = caseMatches[0]!;
		return {
			kind: 'case-suggest',
			actual: hit.value,
			clientID: hit.clientID,
		};
	}
	if (caseMatches.length > 1) {
		return {
			kind: 'case-ambiguous',
			matches: caseMatches.sort(byClientID).map(stripState),
		};
	}
	return { kind: 'not-found' };
}

function stripState(hit: FieldHit): { value: string; clientID: number } {
	return { value: hit.value, clientID: hit.clientID };
}

function byClientID(
	a: { clientID: number },
	b: { clientID: number },
): number {
	return a.clientID - b.clientID;
}
