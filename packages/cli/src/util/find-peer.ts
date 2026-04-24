/**
 * Resolve a `--peer <target>` flag against a map of awareness states.
 *
 * Three modes (no overlap):
 *   - all digits        → `clientID` lookup (numeric)
 *   - contains '='      → `<field>=<value>` (split on first '=')
 *   - otherwise         → match awareness field `deviceName`
 *
 * String-field modes try exact first, then fall back to case-insensitive
 * substring. Miss shapes:
 *   - unique substring hit                       → `case-suggest`
 *   - multiple exact or substring hits           → `case-ambiguous`
 *   - otherwise                                  → `not-found`
 *
 * "Case-insensitive" here means the lowercased target appears as a substring
 * of the lowercased peer value — so `mymacbook` suggests `myMacbook`, and
 * `MACBOOK` reports both `myMacbook` and `workMacbook` as ambiguous.
 *
 * Numeric mode has no fuzzy fallback — a missing clientID is just `not-found`.
 *
 * Edge: `--peer key=val=with=equals` splits on the first '='. The target
 * `--peer 42` with a peer named `deviceName: "42"` still routes to numeric
 * clientID mode. Use `--peer deviceName=42` to disambiguate.
 */
export type AwarenessState = Record<string, unknown>;

export type FindPeerResult =
	| { kind: 'found'; clientID: number }
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
		if (peers.has(clientID)) return { kind: 'found', clientID };
		return { kind: 'not-found' };
	}

	// Mode 2 — `k=v` → explicit field match
	const eq = target.indexOf('=');
	if (eq !== -1) {
		const field = target.slice(0, eq);
		const value = target.slice(eq + 1);
		return matchField(field, value, peers);
	}

	// Mode 3 — bare name → `deviceName`
	return matchField('deviceName', target, peers);
}

function matchField(
	field: string,
	value: string,
	peers: Map<number, AwarenessState>,
): FindPeerResult {
	const exact: Array<{ value: string; clientID: number }> = [];
	const caseMatches: Array<{ value: string; clientID: number }> = [];
	const needle = value.toLowerCase();

	for (const [clientID, state] of peers) {
		const raw = state[field];
		if (typeof raw !== 'string') continue;
		if (raw === value) exact.push({ value: raw, clientID });
		else if (raw.toLowerCase().includes(needle))
			caseMatches.push({ value: raw, clientID });
	}

	if (exact.length === 1) return { kind: 'found', clientID: exact[0]!.clientID };
	if (exact.length > 1) {
		return { kind: 'case-ambiguous', matches: exact.sort(byClientID) };
	}

	if (caseMatches.length === 1) {
		return {
			kind: 'case-suggest',
			actual: caseMatches[0]!.value,
			clientID: caseMatches[0]!.clientID,
		};
	}
	if (caseMatches.length > 1) {
		return { kind: 'case-ambiguous', matches: caseMatches.sort(byClientID) };
	}
	return { kind: 'not-found' };
}

function byClientID(
	a: { clientID: number },
	b: { clientID: number },
): number {
	return a.clientID - b.clientID;
}
