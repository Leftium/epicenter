/**
 * Literal folder-relative paths and row addresses.
 *
 * Paths are never normalized, case folded, or aliased. A path that would need
 * rewriting to be usable is refused so that raw access and Git history address
 * exactly the bytes a person or agent sees.
 */

/** Path segments that are never portable source. `.git` holds private Git state. */
const PRIVATE_SEGMENTS = new Set(['.git']);
/** Operating-system scratch files that commits and status never include. */
const SCRATCH_NAMES = new Set(['.DS_Store']);

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects.
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Why a literal path is unusable, or `undefined` when it is a valid
 * folder-relative path: nonempty `/`-separated segments, no `.` or `..`, no
 * leading slash, backslash, or control character.
 */
export function pathProblem(path: string): string | undefined {
	if (path === '') return 'the path is empty';
	if (path.startsWith('/')) return 'the path must be folder-relative';
	if (path.includes('\\')) return 'the path contains a backslash';
	if (CONTROL.test(path)) return 'the path contains a control character';
	for (const segment of path.split('/')) {
		if (segment === '') return 'the path contains an empty segment';
		if (segment === '.' || segment === '..')
			return 'the path contains a relative segment';
		// Git refuses `.git` at any depth, in any case, as a tracked path.
		if (PRIVATE_SEGMENTS.has(segment.toLowerCase()))
			return 'the path is inside private Git state';
	}
	return undefined;
}

/**
 * Candidate history source: every valid path except operating-system scratch
 * files. `.gitignore` narrows it further in `git/scope.ts`.
 */
export function isPortablePath(path: string): boolean {
	if (pathProblem(path) !== undefined) return false;
	return !SCRATCH_NAMES.has(basename(path));
}

export function basename(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? path : path.slice(slash + 1);
}

export function dirname(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? '' : path.slice(0, slash);
}

/** Every proper ancestor directory of a path, nearest last. */
export function ancestors(path: string): string[] {
	const parts = path.split('/');
	const result: string[] = [];
	for (let index = 1; index < parts.length; index++)
		result.push(parts.slice(0, index).join('/'));
	return result;
}

export const ROW_EXTENSION = '.md';

/**
 * The row file a literal stem names. The stem is used as written: nothing is
 * trimmed, folded, or stripped, and the empty stem names `<table>/.md`.
 */
export function rowPath(table: string, stem: string): string {
	return `${table}/${stem}${ROW_EXTENSION}`;
}

/**
 * Why a stem does not address a row of the table, or `undefined` when it
 * does. A stem is one literal filename segment, so the only rules are the
 * folder's own path rules: there is no portable-name grammar (ADR-0457).
 * Whether the backing filesystem can store the name is its answer to give.
 */
export function rowAddressProblem(
	table: string,
	stem: string,
): string | undefined {
	if (typeof stem !== 'string') return 'the stem is not a string';
	if (stem.includes('/')) return 'the stem contains a path separator';
	return pathProblem(rowPath(table, stem));
}

/**
 * The inverse of `rowPath`: the literal stem of a file directly in the table's
 * directory that ends in exactly `.md`, or `undefined` when the path is not a
 * row. The stem may be empty (`<table>/.md`). `.MD` is not a row.
 */
export function rowStemOf(table: string, path: string): string | undefined {
	const prefix = `${table}/`;
	if (!path.startsWith(prefix)) return undefined;
	const filename = path.slice(prefix.length);
	if (filename.includes('/')) return undefined;
	if (!filename.endsWith(ROW_EXTENSION)) return undefined;
	return filename.slice(0, -ROW_EXTENSION.length);
}

/**
 * Case- and Unicode-folded spelling used only when adopting incoming history,
 * to refuse a commit whose paths some filesystem could not hold apart
 * (ADR-0474). Never used for lookup, and never applied to a local save: a
 * create or rename is refused by what its own filesystem does.
 */
export function collisionKey(path: string): string {
	return path.normalize('NFC').toLowerCase();
}
