/**
 * The contract between the Capture desktop page and the Capture folder owner
 * in the Epicenter host process.
 *
 * The host opens one real directory with `openNativeFolder` and answers on its
 * own authenticated origin. Types only, plus the allowlist both sides read.
 *
 *   POST /_epicenter/capture/call    { path, args } -> { ok } | { fault }
 *   GET  /_epicenter/capture/events  newline-delimited JSON `BridgeEvent`s
 *
 * The methods are the ones Capture uses and no others. Values use the tagged
 * encoding in `codec.ts`. A reply's `ok` is whatever the folder method
 * returned, so a `Result` keeps its error fields. A `fault` is a call the
 * owner did not run: a malformed request, a refused method, or a folder that
 * could not be opened.
 *
 * Quitting is not part of this contract. The desktop shell asks the page
 * directly; see `platform/folder.epicenter-host.ts`.
 */

export const BRIDGE_PATH = '/_epicenter/capture';

/** Every call a page may make. Anything else is refused. */
export const CAPTURE_CALLS = [
	'host.info',
	'captures.list',
	'captures.get',
	'captures.create',
	'captures.writeSource',
	'captures.delete',
	'files.read',
	'files.write',
	'git.snapshot',
	'git.commit',
] as const;

/**
 * The only paths `files.read` and `files.write` accept: a capture file, for
 * writing exact source the table has no method for (an import, a saved copy,
 * a removed file written again), and the import's own records.
 */
export const RAW_PATH =
	/^(?:captures\/[^/]+\.md|recovery\/[^/]+\.(?:json|md))$/;

export type CallRequest = {
	readonly path: readonly string[];
	readonly args: readonly unknown[];
};

export type BridgeReply = { readonly ok: unknown } | { readonly fault: string };

export type BridgeEvent =
	| { readonly type: 'git'; readonly snapshot: unknown }
	/**
	 * Something under the directory changed. A hint to reread: it carries no
	 * bytes and never replaces what an editor holds.
	 */
	| { readonly type: 'files' }
	/** Keeps the stream alive and lets the page notice a silent one. */
	| { readonly type: 'ping' };

export type HostInfo = {
	/** The canonical absolute directory the captures are in. */
	readonly root: string;
};
