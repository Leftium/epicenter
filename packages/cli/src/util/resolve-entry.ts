import type { WorkspaceEntry } from '../load-config';

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
