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
 * tagged encoding in `codec.ts`. `/bridge/call` exposes only the folder
 * operations Honeycrisp consumes; `/bridge/app` handles its shell operations.
 */

import type { GitSnapshot } from '@epicenter/app/files';
import type { NotesFolder } from '../platform/types.js';

/** Paths are coupled to their real folder method's arguments and result. */
export type FolderCallPath =
	| readonly ['tables', 'notes', keyof NotesFolder['tables']['notes']]
	| readonly ['tables', 'folders', keyof NotesFolder['tables']['folders']]
	| readonly ['files', keyof NotesFolder['files']]
	| readonly ['git', 'snapshot' | 'status' | 'commit' | 'log'];

export type FolderCallMethod<TPath extends FolderCallPath> =
	TPath extends readonly [
		'tables',
		'notes',
		infer TMethod extends keyof NotesFolder['tables']['notes'],
	]
		? NotesFolder['tables']['notes'][TMethod]
		: TPath extends readonly [
					'tables',
					'folders',
					infer TMethod extends keyof NotesFolder['tables']['folders'],
				]
			? NotesFolder['tables']['folders'][TMethod]
			: TPath extends readonly [
						'files',
						infer TMethod extends keyof NotesFolder['files'],
					]
				? NotesFolder['files'][TMethod]
				: TPath extends readonly ['git', 'snapshot']
					? () => Promise<GitSnapshot>
					: TPath extends readonly [
								'git',
								infer TMethod extends 'status' | 'commit' | 'log',
							]
						? NotesFolder['git'][TMethod]
						: never;

/** The folder methods a page may call, by namespace. Anything else is refused. */
export const FOLDER_METHODS = {
	tables: {
		notes: [
			'list',
			'get',
			'create',
			'update',
			'writeSource',
			'rename',
			'delete',
		],
		folders: ['list', 'get', 'create', 'update', 'delete'],
	},
	files: ['list', 'read', 'write', 'remove', 'move', 'mkdir', 'rmdir'],
	git: ['snapshot', 'status', 'commit', 'log'],
} as const;

export type CallRequest = {
	readonly path: readonly string[];
	readonly args: readonly unknown[];
};

export type BridgeReply = { readonly ok: unknown } | { readonly fault: string };

export type BridgeEvent =
	| { readonly type: 'git'; readonly snapshot: GitSnapshot }
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
	/** Content saves wait here until released. */
	readonly holdSaves: boolean;
	/** Every content save waits this long before it runs. */
	readonly saveDelayMs: number;
	/** The next N content saves fail without writing. */
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

export function isAllowedCall(path: readonly string[]): boolean {
	const [namespace, second, third] = path;
	if (namespace === 'tables')
		return (
			path.length === 3 &&
			(second === 'notes' || second === 'folders') &&
			(FOLDER_METHODS.tables[second] as readonly string[]).includes(third ?? '')
		);
	if (namespace === 'files' || namespace === 'git')
		return (
			path.length === 2 &&
			(FOLDER_METHODS[namespace] as readonly string[]).includes(second ?? '')
		);
	return false;
}
