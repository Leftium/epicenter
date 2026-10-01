/**
 * The contract between the Honeycrisp page and its desktop folder host.
 *
 * The host is one Bun process the desktop shell starts. It opens the notes
 * directory with `openNativeFolder` and serves the built page and `/bridge`
 * from one loopback origin. Types only, plus the allowlist both sides read.
 *
 *   POST /bridge/call    { path, args } -> { ok } | { fault }
 *   GET  /bridge/events  newline-delimited JSON `BridgeEvent`s
 *   POST /bridge/app     an `AppRequest` -> { ok } | { fault }
 *
 * Every request carries `Authorization: Bearer <token>`. Values use the
 * tagged encoding in `codec.ts`. `/bridge/call` is the folder itself and is
 * app-agnostic; `/bridge/app` is Honeycrisp's own.
 */

/** The folder methods a page may call, by namespace. Anything else is refused. */
export const FOLDER_METHODS = {
	tables: [
		'list',
		'get',
		'create',
		'update',
		'writeSource',
		'rename',
		'delete',
	],
	kv: ['get', 'update', 'writeSource'],
	files: [
		'list',
		'children',
		'read',
		'open',
		'write',
		'remove',
		'move',
		'mkdir',
		'rmdir',
	],
	git: [
		'snapshot',
		'status',
		'commit',
		'paths',
		'stage',
		'commitStaged',
		'diff',
		'log',
	],
} as const;

export type CallRequest = {
	readonly path: readonly string[];
	readonly args: readonly unknown[];
};

export type BridgeReply = { readonly ok: unknown } | { readonly fault: string };

export type BridgeEvent =
	| { readonly type: 'git'; readonly snapshot: unknown }
	/** Something under the root changed; reread what is on screen. */
	| { readonly type: 'files' }
	/** Every native close or quit asks the page to settle or confirm discard. */
	| { readonly type: 'closeRequested' }
	| { readonly type: 'ping' };

export type HostInfo = {
	/** The absolute notes directory. */
	readonly root: string;
	/** Whether fault injection is available (a disposable root only). */
	readonly faults: boolean;
	/** Whether a desktop shell is attached and honors `quit`. */
	readonly shell: boolean;
};

export type TerminalReply = {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
	/** The working directory after the command, absolute. */
	readonly cwd: string;
};

/** Deterministic failures for acceptance testing against a disposable root. */
export type Faults = {
	/** Managed saves wait here until released. */
	readonly holdSaves: boolean;
	/** Every managed save waits this long before it runs. */
	readonly saveDelayMs: number;
	/** The next N managed saves fail without writing. */
	readonly failSaves: number;
	/** The next N requested commits fail without committing. */
	readonly failCommits: number;
};

export type FaultState = Faults & {
	/** Saves currently waiting on `holdSaves`. */
	readonly held: number;
};

export type FileRevision = {
	readonly oid: string;
	readonly subject: string;
	/** Seconds since the epoch. */
	readonly timestamp: number;
};

export type AppRequest =
	| { readonly op: 'info' }
	| { readonly op: 'terminal'; readonly command: string; readonly cwd: string }
	| { readonly op: 'reveal' }
	| { readonly op: 'faults' }
	| { readonly op: 'setFaults'; readonly faults: Partial<Faults> }
	| { readonly op: 'fileLog'; readonly path: string; readonly depth: number }
	| { readonly op: 'show'; readonly oid: string; readonly path: string }
	/** The mounted page received the pending native close request. */
	| { readonly op: 'closeReceived' }
	/** The page agrees to quit: every draft is saved, or the person chose to discard. */
	| { readonly op: 'quit' };

export function isAllowedCall(
	path: readonly string[],
	tables: readonly string[],
): boolean {
	const [namespace, second, third] = path;
	if (namespace === 'tables')
		return (
			path.length === 3 &&
			tables.includes(second ?? '') &&
			(FOLDER_METHODS.tables as readonly string[]).includes(third ?? '')
		);
	if (namespace === 'kv' || namespace === 'files' || namespace === 'git')
		return (
			path.length === 2 &&
			(FOLDER_METHODS[namespace] as readonly string[]).includes(second ?? '')
		);
	return false;
}
