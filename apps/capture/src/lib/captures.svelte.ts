/**
 * The captures in the folder, the drafts open over them, and everything that
 * writes a file.
 *
 * `entries` is the last listing of saved files. A draft exists for each
 * capture that has been opened in this page and is kept until its file is
 * gone, so moving between captures never drops unsaved input. A listing
 * refreshes clean drafts and never replaces a dirty one; see `draft.svelte.ts`.
 *
 * A listing can be older than a write this page made while it was running.
 * Every write moves `writes`; a listing that saw it move is discarded and
 * taken again, so stale files are never shown as current.
 *
 * Git is reported beside saving, never as part of it: a file that saved is
 * saved whether or not its commit worked.
 */

import {
	CAPTURES_TABLE,
	type CaptureDocument,
	type CaptureFields,
	composeBody,
	excerpt,
	parseCapture,
} from '@epicenter/capture';
import {
	type ImportReport,
	type LegacyBundle,
	runLegacyImport,
} from '@epicenter/capture/legacy';
import { type FileCapture, type GitSnapshot, rowPath } from '@epicenter/folder';
import { SvelteMap } from 'svelte/reactivity';
import {
	type CaptureEntry,
	type Current,
	createDraft,
	type Draft,
	type DraftStore,
} from './draft.svelte.js';
import type { CaptureHost } from './platform/types.js';

export type CaptureRow = {
	readonly stem: string;
	readonly path: string;
	/** `undefined` when the file's `capturedAt` is missing or not a date and time. */
	readonly capturedAt: Date | undefined;
	readonly preview: string;
	readonly thoughtCount: number;
	/** Why the file does not read as a capture, when it does not. */
	readonly problem: string | undefined;
	/** This page holds input for it that is not saved. */
	readonly unsettled: boolean;
	/**
	 * What became of the saved file under a draft this page still holds:
	 * changed elsewhere, removed, or unreadable. `undefined` when nothing did.
	 */
	readonly conflict: 'present' | 'removed' | 'unreadable' | undefined;
};

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

const pathOf = (stem: string) => rowPath(CAPTURES_TABLE, stem);

/** A readable, sortable stem: the capture's UTC time and a short random suffix. */
function newStem(at: Date): string {
	const stamp = at
		.toISOString()
		.slice(0, 19)
		.replace(/[-:]/g, '')
		.replace('T', '-');
	const suffix = Array.from(crypto.getRandomValues(new Uint8Array(3)), (byte) =>
		byte.toString(36).padStart(2, '0'),
	)
		.join('')
		.slice(0, 5);
	return `${stamp}-${suffix}`;
}

function timeOf(entry: CaptureEntry): Date | undefined {
	const value = entry.fields.capturedAt;
	if (typeof value !== 'string') return undefined;
	const time = new Date(value);
	return Number.isNaN(time.getTime()) ? undefined : time;
}

export type Captures = ReturnType<typeof createCaptures>;

export function createCaptures(
	host: Pick<CaptureHost, 'folder' | 'location'>,
	options: { batchMs?: number } = {},
) {
	const { folder } = host;
	const table = folder.tables.captures;

	let entries = $state.raw<readonly CaptureEntry[]>([]);
	let unreadable = $state.raw<
		readonly { readonly path: string; readonly message: string }[]
	>([]);
	/** Why the folder could not be listed, when it could not. */
	let listProblem = $state<string | undefined>();
	let loaded = $state(false);
	const drafts = new SvelteMap<string, Draft>();
	let newCapture = $state('');
	let git = $state.raw<GitSnapshot>(folder.git.snapshot);
	const stopGit = folder.git.subscribe((snapshot) => {
		git = snapshot;
	});
	/** The Epicenter service that served this page has stopped. */
	let serviceStopped = $state(false);

	/** Moves when a write starts and when it ends. */
	let writes = 0;
	let creating = $state.raw<
		| Promise<{ ok: true; stem: string } | { ok: false; message: string }>
		| undefined
	>();
	let importing = $state.raw<Promise<ImportReport> | undefined>();
	let copying = $state.raw<
		| Promise<{ ok: true; stem: string } | { ok: false; message: string }>
		| undefined
	>();
	let removing = $state.raw<
		| Promise<{ ok: true } | { ok: false; changed: boolean; message: string }>
		| undefined
	>();
	let discarding: Promise<void> | undefined;
	let closing: Promise<void> | undefined;
	let settling: Promise<number> | undefined;
	async function writing<T>(work: () => Promise<T>): Promise<T> {
		writes++;
		try {
			return await work();
		} finally {
			writes++;
		}
	}

	async function read(stem: string): Promise<Current> {
		const found = await table.get(stem);
		if (found.error !== null)
			return { kind: 'unreadable', message: found.error.message };
		if (found.data === undefined) return { kind: 'removed' };
		return { kind: 'present', entry: found.data };
	}

	/**
	 * Write exact source as the capture at a stem, whose file must be absent.
	 * Resolves the sha256 the folder admitted, which is the acknowledgment. The
	 * entry beside it is that same file read back, and is absent when the path
	 * no longer held it: what another program did afterwards is never taken for
	 * what was written.
	 */
	async function createExact(stem: string, source: string) {
		const written = await writing(() =>
			folder.files.create(pathOf(stem), source),
		);
		if (written.error !== null)
			return { data: null, error: written.error } as const;
		const { sha256 } = written.data;
		// The write is confirmed; a read that fails or throws cannot undo that.
		const current = await read(stem).catch(() => undefined);
		const entry =
			current?.kind === 'present' && current.entry.sha256 === sha256
				? current.entry
				: undefined;
		return { data: { sha256, entry }, error: null } as const;
	}

	const store: DraftStore = {
		write: (baseline, source) => writing(() => table.replace(baseline, source)),
		read: (baseline) => read(baseline.stem),
		recreate: (baseline, source) => createExact(baseline.stem, source),
	};

	function noteSaved(entry: CaptureEntry) {
		entries = [...entries.filter((other) => other.path !== entry.path), entry];
	}

	function draftOf(entry: CaptureEntry): Draft {
		let draft = drafts.get(entry.path);
		if (draft === undefined) {
			draft = createDraft(store, entry, {
				onSaved: noteSaved,
				batchMs: options.batchMs,
			});
			drafts.set(entry.path, draft);
		}
		return draft;
	}

	function drop(path: string): Promise<void> {
		const draft = drafts.get(path);
		drafts.delete(path);
		return draft?.dispose() ?? Promise.resolve();
	}

	let refreshing: Promise<void> | undefined;
	let again = false;

	async function refreshOnce() {
		for (let attempt = 0; ; attempt++) {
			const started = writes;
			let listed: Awaited<ReturnType<typeof table.list>>;
			try {
				listed = await table.list();
			} catch (cause) {
				listProblem = describe(cause);
				return;
			}
			// A write of ours overlapped this listing, so it may predate it.
			if (writes !== started && attempt < 5) continue;
			if (listed.error !== null) {
				listProblem = listed.error.message;
				return;
			}
			listProblem = undefined;
			loaded = true;
			entries = listed.data.entries;
			unreadable = listed.data.unreadable.map((item) => ({
				path: item.path,
				message: item.error.message,
			}));
			const present = new Map(entries.map((entry) => [entry.path, entry]));
			const broken = new Map(
				unreadable.map((item) => [item.path, item.message]),
			);
			for (const [path, draft] of [...drafts]) {
				const entry = present.get(path);
				const message = broken.get(path);
				draft.observe(
					entry !== undefined
						? { kind: 'present', entry }
						: message !== undefined
							? { kind: 'unreadable', message }
							: { kind: 'removed' },
				);
				if (draft.gone) await drop(path);
			}
			return;
		}
	}

	/** Reread the folder. Calls made while one is running share one more pass. */
	function refresh(): Promise<void> {
		if (closing) return refreshing ?? Promise.resolve();
		if (refreshing) {
			again = true;
			return refreshing;
		}
		refreshing = (async () => {
			try {
				do {
					again = false;
					await refreshOnce();
				} while (again);
			} finally {
				refreshing = undefined;
			}
		})();
		return refreshing;
	}

	/** One parse per distinct source, for the timeline. */
	const parsed = new Map<string, CaptureDocument>();
	function documentOf(source: string): CaptureDocument {
		let document = parsed.get(source);
		if (document === undefined) {
			if (parsed.size > 2000) parsed.clear();
			document = parseCapture(source);
			parsed.set(source, document);
		}
		return document;
	}

	const rows = $derived.by((): CaptureRow[] => {
		const conflictOf = (draft: Draft | undefined) =>
			draft?.saveState.kind === 'conflict'
				? draft.saveState.current.kind
				: undefined;
		const list = entries.map((entry): CaptureRow => {
			const draft = drafts.get(entry.path);
			const document = draft?.document ?? documentOf(entry.source);
			return {
				stem: entry.stem,
				path: entry.path,
				capturedAt: timeOf(entry),
				preview: excerpt(document),
				thoughtCount: document.thoughts.length,
				problem: entry.issues?.map((issue) => issue.message).join('; '),
				unsettled: draft?.unsettled ?? false,
				conflict: conflictOf(draft),
			};
		});
		// A draft whose file is no longer listed (removed, or unreadable) still
		// holds input. It stays on the timeline so it can be reached and resolved.
		const listed = new Set(entries.map((entry) => entry.path));
		for (const [path, draft] of drafts) {
			if (listed.has(path)) continue;
			list.push({
				stem: draft.baseline.stem,
				path,
				capturedAt: timeOf(draft.baseline),
				preview: excerpt(draft.document),
				thoughtCount: draft.document.thoughts.length,
				problem: undefined,
				unsettled: draft.unsettled,
				conflict: conflictOf(draft),
			});
		}
		// Newest first by the instant, not the text: offsets differ between files.
		return list.sort((left, right) => {
			const a = left.capturedAt?.getTime();
			const b = right.capturedAt?.getTime();
			if (a !== b) {
				if (a === undefined) return 1;
				if (b === undefined) return -1;
				return b - a;
			}
			return left.stem < right.stem ? -1 : left.stem > right.stem ? 1 : 0;
		});
	});

	function settleAll(): Promise<number> {
		if (settling) return settling;
		settling = (async () => {
			await Promise.allSettled([
				creating,
				importing,
				copying,
				removing,
				discarding,
			]);
			await Promise.all([...drafts.values()].map((draft) => draft.settle()));
			return unsettledDrafts().length + (newCapture === '' ? 0 : 1);
		})().finally(() => {
			settling = undefined;
		});
		return settling;
	}

	const unsettledDrafts = () =>
		[...drafts.values()].filter((draft) => draft.unsettled);

	return {
		location: host.location,
		get rows() {
			return rows;
		},
		get unreadable() {
			return unreadable;
		},
		get listProblem() {
			return listProblem;
		},
		get loaded() {
			return loaded;
		},
		get git() {
			return git;
		},
		/**
		 * The folder's owner closed it: nothing saves from this window again.
		 * The folder reports this itself, on its Git snapshot.
		 */
		get folderStopped() {
			return git.closed;
		},
		get serviceStopped() {
			return serviceStopped;
		},
		/** Saving is the folder's and carries on; the page can load nothing more. */
		markServiceStopped() {
			serviceStopped = true;
		},
		get newCapture() {
			return newCapture;
		},
		set newCapture(value: string) {
			newCapture = value;
		},
		/**
		 * How many things leaving could interrupt: drafts with unsaved or unsent
		 * input, the new-capture text, and unfinished actions.
		 */
		get unsettled() {
			return (
				unsettledDrafts().length +
				(newCapture === '' ? (creating ? 1 : 0) : 1) +
				(importing ? 1 : 0) +
				(copying ? 1 : 0) +
				(removing ? 1 : 0)
			);
		},
		refresh,

		/** The draft for a capture, opening one over its saved file if needed. */
		open(stem: string): Draft | undefined {
			const path = pathOf(stem);
			const existing = drafts.get(path);
			if (existing !== undefined) return existing;
			const entry = entries.find((item) => item.path === path);
			return entry === undefined ? undefined : draftOf(entry);
		},
		/** The draft already open for a capture, without opening one. */
		draft: (stem: string): Draft | undefined => drafts.get(pathOf(stem)),
		/** Whether the last listing has a saved file for this stem. */
		has: (stem: string) => entries.some((item) => item.path === pathOf(stem)),
		/** Why a capture that is not open cannot be read, when the folder said so. */
		unreadableReason(stem: string): string | undefined {
			return unreadable.find((item) => item.path === pathOf(stem))?.message;
		},

		/**
		 * Save the new-capture text as a file. The text stays in the form when
		 * the save fails. Resolves the new stem, or the reason.
		 */
		async create(): Promise<
			{ ok: true; stem: string } | { ok: false; message: string }
		> {
			if (closing || settling)
				return { ok: false, message: 'Capture is finishing its saves.' };
			if (creating) return creating;
			creating = (async (): Promise<
				{ ok: true; stem: string } | { ok: false; message: string }
			> => {
				const text = newCapture;
				// Blank text is refused, and stays in the form: only the person clears it.
				if (text.trim() === '')
					return { ok: false, message: 'Write something first.' };
				const now = new Date();
				const { body } = composeBody(text);
				try {
					for (let attempt = 0; ; attempt++) {
						const created = await writing(() =>
							table.create({
								stem: newStem(now),
								fields: {
									capturedAt: now.toISOString() as CaptureFields['capturedAt'],
								},
								body,
							}),
						);
						if (created.error === null) {
							noteSaved(created.data);
							if (newCapture === text) newCapture = '';
							return { ok: true, stem: created.data.stem };
						}
						const taken =
							created.error.name === 'Exists' ||
							created.error.name === 'Collision';
						if (!taken || attempt >= 3)
							return { ok: false, message: created.error.message };
					}
				} catch (cause) {
					return { ok: false, message: describe(cause) };
				}
			})().finally(() => {
				creating = undefined;
			});
			return creating;
		},

		/**
		 * Save a draft's source as a new capture and let go of the draft. For a
		 * draft whose own file changed, was removed, or cannot be read.
		 *
		 * The copy is the source only, as it was when this was called. Text typed
		 * but not yet in the source (a new thought, a thought being edited,
		 * capture text that was refused) would be dropped with the draft, so the
		 * copy is refused while any exists, and nothing is written.
		 *
		 * The draft is let go only if the copy holds all of it. Input that
		 * arrived while the copy was being written is not in the copy, so the
		 * draft stays, unsettled, beside it. The copy is saved either way.
		 */
		async saveCopy(
			draft: Draft,
		): Promise<{ ok: true; stem: string } | { ok: false; message: string }> {
			if (closing || settling)
				return { ok: false, message: 'Capture is finishing its saves.' };
			if (copying)
				return { ok: false, message: 'A copy is already being saved.' };
			copying = (async (): Promise<
				{ ok: true; stem: string } | { ok: false; message: string }
			> => {
				if (draft.hasUnsentInput)
					return {
						ok: false,
						message:
							'A copy holds the capture as it is in Source. This capture also has text you typed that is not in it yet: a new thought, a thought you are editing, or capture text that could not be applied. Add it, or copy it somewhere and clear it, then save the copy.',
					};
				const source = draft.buffer;
				try {
					const stem = `${newStem(new Date())}-copy`;
					const created = await createExact(stem, source);
					if (created.error !== null)
						return { ok: false, message: created.error.message };
					if (created.data.entry !== undefined) noteSaved(created.data.entry);
					// Another draft may have been opened at the path since; it is not this one.
					if (
						drafts.get(draft.path) === draft &&
						draft.buffer === source &&
						!draft.hasUnsentInput
					)
						await drop(draft.path);
					void refresh();
					return { ok: true, stem };
				} catch (cause) {
					return { ok: false, message: describe(cause) };
				}
			})().finally(() => {
				copying = undefined;
			});
			return copying;
		},

		/** Let go of a draft and its input without writing anything. */
		discard(draft: Draft): Promise<void> {
			const completion = Promise.all([discarding, drop(draft.path)])
				.then(() => refresh())
				.finally(() => {
					if (discarding === completion) discarding = undefined;
				});
			discarding = completion;
			return completion;
		},

		/** The saved file as it is now, to review before deleting it. */
		async reviewDeletion(
			stem: string,
		): Promise<
			{ ok: true; entry: CaptureEntry } | { ok: false; message: string }
		> {
			try {
				const current = await read(stem);
				if (current.kind === 'present')
					return { ok: true, entry: current.entry };
				return {
					ok: false,
					message:
						current.kind === 'removed'
							? 'This capture is already gone.'
							: current.message,
				};
			} catch (cause) {
				return { ok: false, message: describe(cause) };
			}
		},
		/**
		 * Delete exactly the file that was reviewed. Refused if it changed since;
		 * `changed` then asks for another review.
		 */
		async remove(
			reviewed: CaptureEntry,
		): Promise<
			{ ok: true } | { ok: false; changed: boolean; message: string }
		> {
			if (closing || settling)
				return {
					ok: false,
					changed: false,
					message: 'Capture is finishing its saves.',
				};
			if (removing)
				return {
					ok: false,
					changed: false,
					message: 'A capture is already being deleted.',
				};
			removing = (async (): Promise<
				{ ok: true } | { ok: false; changed: boolean; message: string }
			> => {
				try {
					const removed = await writing(() => table.delete(reviewed));
					if (removed.error !== null)
						return {
							ok: false,
							changed: removed.error.name === 'Conflict',
							message: removed.error.message,
						};
					await drop(reviewed.path);
					entries = entries.filter((entry) => entry.path !== reviewed.path);
					return { ok: true };
				} catch (cause) {
					return { ok: false, changed: false, message: describe(cause) };
				}
			})().finally(() => {
				removing = undefined;
			});
			return removing;
		},

		/** Import the whole export, including its report, receipt, and fresh listing. */
		importLegacy(bundle: LegacyBundle): Promise<ImportReport> {
			if (closing || settling)
				return Promise.reject(new Error('Capture is finishing its saves.'));
			if (importing) return importing;
			importing = (async () => {
				const report = await runLegacyImport(
					{
						read: (path: string) => folder.files.read(path),
						create: (path: string, content: string | Uint8Array) =>
							writing(() => folder.files.create(path, content)),
						replace: (file: FileCapture, content: string | Uint8Array) =>
							writing(() => folder.files.replace(file, content)),
					},
					bundle,
				);
				await refresh();
				return report;
			})().finally(() => {
				importing = undefined;
			});
			return importing;
		},
		commit: () => folder.git.commit(),

		/**
		 * Wait for submitted actions and save every draft that can be saved.
		 * Resolves how many things are still
		 * unsettled, which is what quitting would lose.
		 */
		settleAll,
		/** Finish intended saves before the page releases its folder. Explicit
		 * discard waits only for submitted actions and drops later draft input. */
		close(options: { discard?: boolean } = {}): Promise<void> {
			if (closing) return closing;
			closing = (async () => {
				try {
					if (options.discard) {
						await Promise.allSettled([
							creating,
							importing,
							copying,
							removing,
							discarding,
							...[...drafts.values()].map((draft) => draft.dispose()),
						]);
					} else await settleAll();
					await refreshing;
				} finally {
					stopGit();
					for (const draft of drafts.values()) draft.dispose();
				}
			})();
			return closing;
		},
	};
}
