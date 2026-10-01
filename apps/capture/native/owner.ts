/**
 * The one owner of the Capture directory in a host process.
 *
 * Every window reaches the directory through this owner, so there is one open
 * folder, one queue, and one place where a save is followed by its commit.
 *
 * - One acquisition. The first call opens the directory; every later call
 *   shares that promise. A failed acquisition is forgotten, so the next call
 *   tries again once the cause is fixed.
 * - One queue. Each call runs to completion in its own slot, so two windows
 *   saving against the same version get one success and one conflict.
 * - Automatic commits are the folder's own. It is opened with
 *   `commitOnEdit: true`, so every complete save, table or raw, requests its
 *   commit. A save answers without waiting for it, and a commit that fails is
 *   reported in the Git snapshot, never as a save error.
 * - The watcher's baseline follows this owner's writes. After each write the
 *   directory is compared at once, so a file this owner created and another
 *   program then removed is noticed even when no native event arrives.
 * - The layout is checked before any Git command runs: a `.git` that is a
 *   symbolic link or points at another Git directory is refused.
 * - Closing fences admission, stops the watcher, lets every admitted
 *   operation finish, and only then closes the folder, which settles its
 *   commits, and releases the lock.
 *
 * There is no remote, no terminal, and no method outside `CAPTURE_CALLS`.
 * Checks against a file's version are best effort against other programs: an
 * edit landing between the check and the replacement is overwritten.
 */
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileExpectation, Folder } from '@epicenter/app/files';
import {
	createGitRunner,
	openNativeFolder,
	verifyNativeLayout,
} from '@epicenter/app/files/native';
import { CAPTURES_TABLE, captureDefinition } from '@epicenter/capture';
import {
	type BridgeEvent,
	type CallRequest,
	type HostInfo,
	RAW_PATH,
} from '../src/lib/bridge/contract.js';
import { acquireRootLock, type RootLock } from './root-lock.js';
import { createWatcher, type Watcher } from './watch.js';

type NativeCaptureFolder = Folder<typeof captureDefinition>;
type CaptureTable = NativeCaptureFolder['tables']['captures'];
type CaptureEntry = Parameters<CaptureTable['writeSource']>[0];

export type CaptureOwnerOptions = {
	/** The Capture directory, chosen by native startup. Created when absent. */
	readonly root: string;
	readonly watchIntervalMs?: number;
};

export type CaptureOwner = ReturnType<typeof createCaptureOwner>;

/** A call this owner did not run. The bridge reports its message as a fault. */
export class RefusedCallError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RefusedCallError';
	}
}

export const OWNER_CLOSED = 'The Capture folder is closed.';

const MAX_TEXT = 64 * 1024 * 1024;
const MAX_PATH = 4096;

function refuse(reason: string): never {
	throw new RefusedCallError(reason);
}

function arity(args: readonly unknown[], count: number) {
	if (args.length !== count)
		refuse(`Expected ${count} ${count === 1 ? 'argument' : 'arguments'}.`);
}

function text(value: unknown, name: string, max = MAX_PATH): string {
	if (typeof value !== 'string') refuse(`${name} must be a string.`);
	if (value.length > max) refuse(`${name} is too long.`);
	return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		value instanceof Uint8Array ||
		value instanceof Map ||
		value instanceof Error
	)
		refuse(`${name} must be an object.`);
	return value as Record<string, unknown>;
}

function expectation(value: unknown, name: string): FileExpectation {
	// `any` is a deliberate overwrite, which Capture never asks for.
	if (value === 'absent') return value;
	const object = record(value, name);
	if (
		typeof object.sha256 !== 'string' ||
		!/^[0-9a-f]{64}$/.test(object.sha256) ||
		typeof object.size !== 'number' ||
		!Number.isSafeInteger(object.size) ||
		object.size < 0
	)
		refuse(`${name} must be 'absent' or a file version.`);
	return { sha256: object.sha256, size: object.size };
}

function rawPath(value: unknown): string {
	const path = text(value, 'path');
	if (!RAW_PATH.test(path))
		refuse('path must be a capture file or an import record.');
	return path;
}

/**
 * A row a page captured earlier. Only the fields the table reads are kept,
 * each with the type the table expects; the folder still decides whether the
 * row is current.
 */
function entry(value: unknown): CaptureEntry {
	const object = record(value, 'entry');
	const version = expectation(object.version, 'entry.version');
	if (typeof version === 'string') refuse('entry.version must be a version.');
	const { attachment, issues } = object;
	if (attachment !== undefined && typeof attachment !== 'string')
		refuse('entry.attachment must be a path.');
	if (
		issues !== undefined &&
		!(
			Array.isArray(issues) &&
			issues.every(
				(issue) =>
					typeof issue === 'object' &&
					issue !== null &&
					typeof issue.kind === 'string' &&
					(issue.kind !== 'attachment' ||
						(Array.isArray(issue.candidates) &&
							issue.candidates.every(
								(candidate: unknown) => typeof candidate === 'string',
							))),
			)
		)
	)
		refuse('entry.issues must be a list of issues.');
	return {
		path: text(object.path, 'entry.path'),
		version,
		source: text(object.source, 'entry.source', MAX_TEXT),
		attachment,
		stem: typeof object.stem === 'string' ? object.stem : undefined,
		fields:
			typeof object.fields === 'object' && object.fields !== null
				? object.fields
				: {},
		body: typeof object.body === 'string' ? object.body : undefined,
		issues,
	} as CaptureEntry;
}

type Handler = (args: readonly unknown[]) => Promise<unknown>;

type Opened = {
	readonly folder: NativeCaptureFolder;
	readonly lock: RootLock;
	readonly watcher: Watcher;
	readonly unsubscribe: () => void;
	readonly handlers: ReadonlyMap<string, Handler>;
};

type Subscriber = {
	event(event: BridgeEvent): void;
	/** The owner is closing; no further events follow. */
	end(): void;
};

/** Calls whose completed bytes become the watcher's next polling baseline. */
const CONTENT_CALLS = new Set([
	'captures.create',
	'captures.writeSource',
	'captures.delete',
	'files.write',
]);

export function createCaptureOwner(options: CaptureOwnerOptions) {
	const subscribers = new Set<Subscriber>();
	let opening: Promise<Opened> | undefined;
	let closing: Promise<void> | undefined;
	let fenced = false;
	/** Settles when the last queued slot has; never rejects. */
	let tail: Promise<void> = Promise.resolve();

	function emit(event: BridgeEvent) {
		for (const subscriber of subscribers) {
			try {
				subscriber.event(event);
			} catch {
				// One window's broken stream never stops another window's events.
			}
		}
	}

	/** Run `work` after everything queued before it, whether that succeeded or not. */
	function slot<T>(work: () => Promise<T>): Promise<T> {
		const result = tail.then(work);
		tail = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	async function open(): Promise<Opened> {
		await mkdir(options.root, { recursive: true });
		// The canonical directory is what the lock, Git, and the person all name.
		const root = await realpath(options.root);
		const lock = acquireRootLock(root);
		try {
			// A new directory gets its table directory; existing files are untouched.
			await mkdir(join(root, CAPTURES_TABLE), { recursive: true });
			// Before any Git command, including the configuration reads below: a
			// linked `.git` would send them to someone else's repository.
			await verifyNativeLayout(root);
			const run = createGitRunner(root);
			// History is real Git. Say so plainly when there is none to run.
			await run(['--version']).catch((cause: { code?: string }) => {
				throw cause.code === 'ENOENT'
					? new Error(
							'Capture keeps its history with Git, and no git program was found on this computer. Install Git, then open Capture again.',
							{ cause },
						)
					: cause;
			});
			const configured = async (key: string) => {
				const found = await run(['config', '--get', key], {
					allowFailure: true,
				});
				const value = Buffer.from(found.stdout).toString('utf8').trim();
				return found.code === 0 && value !== '' ? value : undefined;
			};
			const folder = await openNativeFolder({
				root,
				definition: captureDefinition,
				git: {
					author: {
						name: (await configured('user.name')) ?? 'Capture',
						email: (await configured('user.email')) ?? 'capture@localhost',
					},
					commitOnEdit: true,
				},
			});
			try {
				const unsubscribe = folder.git.subscribe((snapshot) =>
					emit({ type: 'git', snapshot }),
				);
				const watcher = await createWatcher(
					root,
					() => emit({ type: 'files' }),
					{ intervalMs: options.watchIntervalMs },
				);
				return {
					folder,
					lock,
					watcher,
					unsubscribe,
					handlers: createHandlers(folder, { root }),
				};
			} catch (cause) {
				await folder.close();
				throw cause;
			}
		} catch (cause) {
			lock.release();
			throw cause;
		}
	}

	function acquire(): Promise<Opened> {
		if (fenced) return Promise.reject(new RefusedCallError(OWNER_CLOSED));
		opening ??= open().catch((cause) => {
			// Let the next call try again; this failure is not the owner's state.
			opening = undefined;
			throw cause;
		});
		return opening;
	}

	function createHandlers(
		folder: NativeCaptureFolder,
		info: HostInfo,
	): ReadonlyMap<string, Handler> {
		const { files } = folder;
		const table = folder.tables.captures;

		const handlers: Record<string, Handler> = {
			'host.info': async (args) => {
				arity(args, 0);
				return info;
			},
			'captures.list': async (args) => {
				arity(args, 0);
				return slot(() => table.list());
			},
			'captures.get': async (args) => {
				arity(args, 1);
				const stem = text(args[0], 'stem');
				return slot(() => table.get(stem));
			},
			'captures.create': async (args) => {
				arity(args, 1);
				const input = record(args[0], 'input');
				if (input.attachment !== undefined)
					refuse('A capture has no attachment.');
				const create = {
					stem: input.stem === undefined ? undefined : text(input.stem, 'stem'),
					fields: record(input.fields, 'fields'),
					body:
						input.body === undefined
							? undefined
							: text(input.body, 'body', MAX_TEXT),
				} as Parameters<CaptureTable['create']>[0];
				return slot(() => table.create(create));
			},
			'captures.writeSource': async (args) => {
				arity(args, 2);
				const row = entry(args[0]);
				const source = text(args[1], 'source', MAX_TEXT);
				return slot(() => table.writeSource(row, source));
			},
			'captures.delete': async (args) => {
				arity(args, 1);
				const row = entry(args[0]);
				return slot(() => table.delete(row));
			},
			'files.read': async (args) => {
				arity(args, 1);
				const path = rawPath(args[0]);
				return slot(() => files.read(path));
			},
			'files.write': async (args) => {
				arity(args, 3);
				const path = rawPath(args[0]);
				const content = text(args[1], 'content', MAX_TEXT);
				const condition = {
					expected: expectation(
						record(args[2], 'options').expected,
						'expected',
					),
				};
				return slot(() => files.write(path, content, condition));
			},
			'git.snapshot': async (args) => {
				arity(args, 0);
				return folder.git.snapshot;
			},
			'git.commit': async (args) => {
				arity(args, 0);
				return slot(() => folder.git.commit());
			},
		};
		// A Map, so a method name can never reach an inherited property.
		return new Map(Object.entries(handlers));
	}

	/** Wait for every queued slot. */
	async function drain() {
		for (;;) {
			const seen = tail;
			await seen;
			if (seen === tail) return;
		}
	}

	return {
		/**
		 * Run one allowlisted call. Rejects with `RefusedCallError` for a call
		 * that is malformed, not allowed, or arrives after closing started, and
		 * with the acquisition's own error when the directory cannot be opened.
		 */
		async call(request: CallRequest): Promise<unknown> {
			const { path, args } = request ?? {};
			if (
				!Array.isArray(path) ||
				path.length !== 2 ||
				!path.every((part) => typeof part === 'string') ||
				!Array.isArray(args)
			)
				refuse('A call needs a method path and a list of arguments.');
			const opened = await acquire();
			// Closing may have started while the directory was opening.
			if (fenced) refuse(OWNER_CLOSED);
			const handler = opened.handlers.get(path.join('.'));
			if (handler === undefined)
				refuse(`Not a Capture folder method: ${JSON.stringify(path)}`);
			const key = path.join('.');
			const result = await handler(args);
			// Without native events, an outside removal just after our creation
			// could match the pre-creation polling baseline and never be noticed.
			if (CONTENT_CALLS.has(key)) await opened.watcher.scan();
			return result;
		},
		/**
		 * Deliver the current Git snapshot, then every event, until the returned
		 * function is called or the owner closes.
		 */
		async subscribe(subscriber: Subscriber): Promise<() => void> {
			const opened = await acquire();
			if (fenced) refuse(OWNER_CLOSED);
			subscriber.event({
				type: 'git',
				snapshot: opened.folder.git.snapshot,
			});
			subscribers.add(subscriber);
			return () => subscribers.delete(subscriber);
		},
		/** Compare the directory now instead of at the next timer tick. */
		async scan(): Promise<boolean> {
			return (await opening)?.watcher.scan() ?? false;
		},
		close(): Promise<void> {
			fenced = true;
			closing ??= (async () => {
				const opened = await opening?.catch(() => undefined);
				for (const subscriber of [...subscribers]) {
					subscribers.delete(subscriber);
					try {
						subscriber.end();
					} catch {
						// The stream was already gone.
					}
				}
				if (opened === undefined) return;
				try {
					await opened.watcher.close();
					opened.unsubscribe();
					await drain();
					await opened.folder.close();
				} finally {
					opened.lock.release();
				}
			})();
			return closing;
		},
	};
}
