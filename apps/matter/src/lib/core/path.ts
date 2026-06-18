/**
 * A path's basename: its last segment, on either separator. This is the one place the
 * "folder label from an absolute path" rule lives, so the vault, its tables, and the
 * persisted tab list all read the same name for the same path. Per-file path work stays
 * in Rust; this is the JS side's folder-level label only.
 */
export const basename = (path: string): string =>
	path.split(/[/\\]/).pop() ?? path;

/**
 * Join a segment onto an absolute folder path, reusing the path's own separator (a
 * Windows path keeps `\`, a POSIX path keeps `/`). The one place the vault builds its
 * hidden `<root>/.matter` dir path, so the separator rule lives next to {@link basename}
 * rather than being hand-spliced at the call site.
 */
export const join = (path: string, segment: string): string => {
	const separator = path.includes('\\') ? '\\' : '/';
	return `${path.replace(/[/\\]+$/, '')}${separator}${segment}`;
};
