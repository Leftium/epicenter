import type { WorkspaceEntry } from '../load-config';

/**
 * Resolve a single `WorkspaceEntry` from a config's exports. Throws on
 * unknown workspace name or ambiguity (no `-w` against a multi-export
 * config). Daemon route handlers let the throw propagate to Hono, which
 * surfaces it on the client side as `DaemonError.HandlerCrashed`.
 */
export function resolveEntry(
	entries: WorkspaceEntry[],
	workspace: string | undefined,
): WorkspaceEntry {
	const names = entries.map((e) => e.name).join(', ');

	if (workspace !== undefined) {
		const entry = entries.find((e) => e.name === workspace);
		if (!entry) {
			throw new Error(`No workspace '${workspace}'. Available: ${names}`);
		}
		return entry;
	}

	if (entries.length === 1) return entries[0]!;

	throw new Error(
		`Multiple workspaces found. Specify one with -w <name>.\nAvailable: ${names}`,
	);
}
