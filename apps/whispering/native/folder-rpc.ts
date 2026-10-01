/**
 * Runs one bridged folder call against an opened folder.
 *
 * The page sends a method path and its arguments; this resolves the path
 * against a fixed list of folder methods, calls it, and returns what the
 * folder returned. Only a `Blob` changes shape on the way out, since a Blob
 * cannot be serialized: `files.open` answers with its bytes.
 *
 * Nothing here is specific to Whispering.
 */
import type { DataDefinition } from '@epicenter/app/definition';
import type { Folder } from '@epicenter/app/files';

type AnyFolder = Folder<DataDefinition>;

const TABLE_METHODS = new Set([
	'list',
	'get',
	'create',
	'update',
	'writeSource',
	'rename',
	'delete',
]);
const KV_METHODS = new Set(['get', 'update', 'writeSource']);
const FILE_METHODS = new Set([
	'list',
	'children',
	'read',
	'open',
	'write',
	'remove',
	'move',
	'mkdir',
	'rmdir',
]);
const GIT_METHODS = new Set([
	'status',
	'commit',
	'commitAndPush',
	'push',
	'fetch',
	'pullFastForward',
	'paths',
	'stage',
	'commitStaged',
	'diff',
	'log',
]);

export class UnknownFolderCall extends Error {
	constructor(path: readonly string[]) {
		super(`'${path.join('.')}' is not a folder method`);
		this.name = 'UnknownFolderCall';
	}
}

type Method = (...args: unknown[]) => unknown;

function resolve(folder: AnyFolder, path: readonly string[]): Method {
	const [area, first, second] = path;
	if (area === 'git' && first === 'snapshot' && path.length === 2)
		return () => folder.git.snapshot;
	if (area === 'tables' && path.length === 3 && second !== undefined) {
		const table =
			first !== undefined && Object.hasOwn(folder.tables, first)
				? (folder.tables as unknown as Record<string, Record<string, Method>>)[
						first
					]
				: undefined;
		const method = TABLE_METHODS.has(second) ? table?.[second] : undefined;
		if (method !== undefined) return method.bind(table);
	}
	if (path.length === 2 && first !== undefined) {
		const owner =
			area === 'kv' && KV_METHODS.has(first)
				? folder.kv
				: area === 'files' && FILE_METHODS.has(first)
					? folder.files
					: area === 'git' && GIT_METHODS.has(first)
						? folder.git
						: undefined;
		const method = (owner as Record<string, Method> | undefined)?.[first];
		if (method !== undefined) return method.bind(owner);
	}
	throw new UnknownFolderCall(path);
}

export async function callFolder(
	folder: AnyFolder,
	path: readonly string[],
	args: readonly unknown[],
): Promise<unknown> {
	const result = await resolve(folder, path)(...args);
	if (path[0] === 'files' && path[1] === 'open') {
		const opened = result as { data: Blob | null; error: unknown };
		if (opened.error === null && opened.data !== null)
			return {
				data: new Uint8Array(await opened.data.arrayBuffer()),
				error: null,
			};
	}
	return result;
}
