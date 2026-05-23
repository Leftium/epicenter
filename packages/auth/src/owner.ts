import { type } from 'arktype';

/**
 * Who owns the workspace data this request touches.
 *
 * Personal mode: a single user; their userId is the partition key for
 *                local storage and server-side durable identifiers.
 * Team mode:     the deployment itself; there is no partition. Every
 *                signed-in member of the deployment shares one workspace.
 *
 * The same shape flows from the server's `/api/session` response, through
 * the persisted auth cell, into auth state, and through to the workspace
 * daemon. Clients pattern-match on `kind` to render team-aware UI;
 * `ownerId(owner)` produces the stable string key local storage uses to
 * disambiguate owners on the same machine.
 */
export const Owner = type(
	{
		kind: "'personal'",
		userId: 'string',
	},
	'|',
	{
		kind: "'team'",
	},
);

export type Owner = typeof Owner.infer;

/**
 * The set of valid Owner discriminators.
 */
export type OwnerKind = Owner['kind'];

/**
 * Stable string identifier for the owner.
 *
 * Personal: `users/<userId>` (matches the partition prefix the server
 *            writes for DO names, R2 keys, and local IDB names).
 * Team:      `''` (empty string). Team mode has no partition, so there
 *            is nothing to identify. Disambiguation across two team
 *            servers on the same machine comes from the API origin
 *            (`${origin}/${ownerId}`), not from a sentinel inside this
 *            string. `kind: 'team'` remains the sole place the word
 *            `team` appears as a value.
 */
export function ownerId(owner: Owner): string {
	return owner.kind === 'personal' ? `users/${owner.userId}` : '';
}
