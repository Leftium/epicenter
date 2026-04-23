import type { LoadConfigResult } from '../load-config';

type Entry = LoadConfigResult['entries'][number];

export function resolveEntry(
	entries: LoadConfigResult['entries'],
	workspace: string | undefined,
): Entry {
	if (entries.length === 1) return entries[0]!;

	const names = entries.map((e) => e.name).join(', ');

	if (!workspace) {
		throw new Error(
			`Multiple workspaces found. Specify one with -w <name>.\nAvailable: ${names}`,
		);
	}

	const entry = entries.find((e) => e.name === workspace);
	if (!entry) {
		throw new Error(`No workspace '${workspace}'. Available: ${names}`);
	}
	return entry;
}
