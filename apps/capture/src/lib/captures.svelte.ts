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
import type { FileCapture, GitSnapshot } from '@epicenter/folder';
import {
	CAPTURES_TABLE,
	type CaptureDocument,
	type CaptureFields,
	composeBody,
	excerpt,
	parseCapture,
} from '@epicenter/capture';
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

const stemOf = (path: string) =>
	path.slice(CAPTURES_TABLE.length + 1, -'.md'.length);

const pathOf = (stem: string) => `${CAPTURES_TABLE}/${stem}.md`;

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
	async function writing<T>(work: () => Promise<T>): Promise<T> {
		writes++;
		try {
			return await work();
		} finally {
			writes++;
		}
	}

	async function read(path: string): Promise<Current> {
		const found = await table.get(stemOf(path));
		if (found.error !== null)
			return { kind: 'unreadable', message: found.error.message };
		if (found.data === undefined) return { kind: 'removed' };
		return { kind: 'present', entry: found.data };
	}

	/** Write exact source at a path that must be absent, and read it back as an entry. */
	async function createExact(path: string, source: string) {
		const written = await writing(() =>
			folder.files.create(path, source),
		);
		if (written.error !== null)
			return { data: null, error: written.error } as const;
		const current = await read(path);
		if (current.kind === 'present')
			return { data: current.entry, error: null } as const;
		return {
			data: null,
			error: {
				name: 'Io',
				message:
					current.kind === 'removed'
						? 'The file was saved and then removed.'
						: current.message,
			},
		} as const;
	}

	const store: DraftStore = {
		write: (baseline, source) =>
			writing(() => table.writeSource(baseline, source)),
		read,
		recreate: createExact,
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

	function drop(path: string) {
		drafts.get(path)?.dispose();
		drafts.delete(path);
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
				if (draft.gone) drop(path);
			}
			return;
		}
	}

	/** Reread the folder. Calls made while one is running share one more pass. */
	function refresh(): Promise<void> {
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
				stem: stemOf(entry.path),
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
				stem: stemOf(path),
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
		 * How many things would be lost by leaving: drafts with unsaved or unsent
		 * input, and the new-capture text.
		 */
		get unsettled() {
			return unsettledDrafts().length + (newCapture === '' ? 0 : 1);
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
							fields: { capturedAt: now.toISOString() as CaptureFields['capturedAt'] },
							body,
						}),
					);
					if (created.error === null) {
						noteSaved(created.data);
						if (newCapture === text) newCapture = '';
						return { ok: true, stem: stemOf(created.data.path) };
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
		},

		/**
		 * Save a draft's source as a new capture and let go of the draft. For a
		 * draft whose own file changed, was removed, or cannot be read.
		 *
		 * The copy is the source only. Text typed but not yet in the source (a
		 * new thought, a thought being edited, capture text that was refused)
		 * would be dropped with the draft, so the copy is refused while any
		 * exists, and nothing is written.
		 */
		async saveCopy(
			draft: Draft,
		): Promise<{ ok: true; stem: string } | { ok: false; message: string }> {
			if (draft.hasUnsentInput)
				return {
					ok: false,
					message:
						'A copy holds the capture as it is in Source. This capture also has text you typed that is not in it yet: a new thought, a thought you are editing, or capture text that could not be applied. Add it, or copy it somewhere and clear it, then save the copy.',
				};
			try {
				const stem = `${newStem(new Date())}-copy`;
				const created = await createExact(pathOf(stem), draft.buffer);
				if (created.error !== null)
					return { ok: false, message: created.error.message };
				noteSaved(created.data);
				drop(draft.path);
				void refresh();
				return { ok: true, stem };
			} catch (cause) {
				return { ok: false, message: describe(cause) };
			}
		},

		/** Let go of a draft and its input without writing anything. */
		discard(draft: Draft) {
			drop(draft.path);
			void refresh();
		},

		/** The saved file as it is now, to review before deleting it. */
		async reviewDeletion(
			stem: string,
		): Promise<
			{ ok: true; entry: CaptureEntry } | { ok: false; message: string }
		> {
			try {
				const current = await read(pathOf(stem));
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
			try {
				const removed = await writing(() => table.delete(reviewed));
				if (removed.error !== null)
					return {
						ok: false,
						changed: removed.error.name === 'Conflict',
						message: removed.error.message,
					};
				drop(reviewed.path);
				entries = entries.filter((entry) => entry.path !== reviewed.path);
				return { ok: true };
			} catch (cause) {
				return { ok: false, changed: false, message: describe(cause) };
			}
		},

		/** Raw file access for the import, counted as this page's writes. */
		importFiles: {
			read: (path: string) => folder.files.read(path),
			create: (path: string, content: string | Uint8Array) =>
				writing(() => folder.files.create(path, content)),
			replace: (file: FileCapture, content: string | Uint8Array) =>
				writing(() => folder.files.replace(file, content)),
		},
		commit: () => folder.git.commit(),

		/**
		 * Save every draft that can be saved. Resolves how many things are still
		 * unsettled, which is what quitting would lose.
		 */
		async settleAll(): Promise<number> {
			await Promise.all([...drafts.values()].map((draft) => draft.settle()));
			return unsettledDrafts().length + (newCapture === '' ? 0 : 1);
		},
		close() {
			stopGit();
			for (const draft of drafts.values()) draft.dispose();
		},
	};
}
