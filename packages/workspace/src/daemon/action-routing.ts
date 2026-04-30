import { walkActions } from '../shared/actions.js';
import type { WorkspaceEntry } from './types.js';

type WorkspaceActionTarget = {
	entry: WorkspaceEntry;
	localPath: string;
};

type WorkspaceActionPathError = {
	routeName: string;
	available: string[];
};

export function resolveWorkspaceActionTarget(
	entries: WorkspaceEntry[],
	actionPath: string,
):
	| { data: WorkspaceActionTarget; error: null }
	| { data: null; error: WorkspaceActionPathError } {
	const [routeName = '', ...rest] = actionPath.split('.');
	const entry = entries.find((candidate) => candidate.route === routeName);
	if (!entry) {
		return {
			data: null,
			error: {
				routeName,
				available: entries.map((candidate) => candidate.route),
			},
		};
	}
	return {
		data: {
			entry,
			localPath: rest.join('.'),
		},
		error: null,
	};
}

function toWorkspaceActionPath(
	entry: WorkspaceEntry,
	localPath: string,
): string {
	return localPath ? `${entry.route}.${localPath}` : entry.route;
}

export function workspaceActionSuggestionLines(
	entry: WorkspaceEntry,
	prefix: string,
): string[] {
	const entries = [...walkActions(entry.workspace.actions)];
	const descendants = entriesUnder(entries, prefix);
	return descendants.map(
		([path, action]) =>
			`  ${toWorkspaceActionPath(entry, path)}  (${action.type})`,
	);
}

export function workspaceActionNearestSiblingLines(
	entry: WorkspaceEntry,
	missedPath: string,
): string[] {
	const entries = [...walkActions(entry.workspace.actions)];
	const parts = missedPath.split('.');
	while (parts.length > 0) {
		parts.pop();
		const prefix = parts.join('.');
		const alts = entriesUnder(entries, prefix);
		if (alts.length === 0) continue;
		return alts.map(
			([path, action]) =>
				`  ${toWorkspaceActionPath(entry, path)}  (${action.type})`,
		);
	}
	return [];
}

function entriesUnder<TValue>(
	entries: Array<[string, TValue]>,
	prefix: string,
): Array<[string, TValue]> {
	if (!prefix) return entries;
	const pfx = `${prefix}.`;
	return entries.filter(([path]) => path === prefix || path.startsWith(pfx));
}
