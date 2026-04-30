import {
	type ActionManifest,
	describeActions,
	walkActions,
} from '../shared/actions.js';
import type { WorkspaceEntry } from './types.js';

type WorkspaceActionTarget = {
	entry: WorkspaceEntry;
	localPath: string;
};

type WorkspaceActionPathError = {
	exportName: string;
	available: string[];
};

export function describeWorkspaceActions(
	entries: WorkspaceEntry[],
): ActionManifest {
	const manifest: ActionManifest = {};
	for (const entry of entries) {
		const actions = describeActions(entry.workspace);
		for (const [path, meta] of Object.entries(actions)) {
			manifest[toWorkspaceActionPath(entry, path)] = meta;
		}
	}
	return manifest;
}

export function resolveWorkspaceActionTarget(
	entries: WorkspaceEntry[],
	actionPath: string,
):
	| { data: WorkspaceActionTarget; error: null }
	| { data: null; error: WorkspaceActionPathError } {
	const [exportName = '', ...rest] = actionPath.split('.');
	const entry = entries.find((candidate) => candidate.name === exportName);
	if (!entry) {
		return {
			data: null,
			error: {
				exportName,
				available: entries.map((candidate) => candidate.name),
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
	return localPath ? `${entry.name}.${localPath}` : entry.name;
}

export function workspaceActionSuggestionLines(
	entry: WorkspaceEntry,
	prefix: string,
): string[] {
	const entries = [...walkActions(entry.workspace)];
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
	const entries = [...walkActions(entry.workspace)];
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
	const pfx = prefix + '.';
	return entries.filter(([path]) => path === prefix || path.startsWith(pfx));
}
