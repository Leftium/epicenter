/**
 * The captures in the folder, the drafts open over them, and everything that
 * writes a file.
 *
 * `entries` is the last listing of saved files. A draft exists for each
 * capture that has been opened in this page and is kept until its file is
 * no longer listed and it holds nothing, so moving between captures never
 * drops unsaved input. Each draft keeps the folder's row editor for its file;
 * see `draft.svelte.ts`. A listing never reads an open draft's file into it:
 * an open capture shows its own input until the person reloads it.
 *
 * A listing can be older than a create, copy, or import this page made while
 * it was running. Those writes move `writes`; a listing that saw it move is
 * discarded and taken again. An open draft's own saves need no such guard:
 * the timeline shows an open capture from its draft, not from the listing.
 *
 * Leaving and closing fence every input and action at once, before anything
 * is awaited, then wait for every action already admitted, each in the one
 * registry they all join, and for each draft's own file work. Leaving can be
 * called off, and then everything is as it was. Reading, copying text out,
 * and downloading stay open: they change nothing.
 *
 * Git is reported beside saving, never as part of it: a file that saved is
 * saved whether or not its commit worked.
 */

import {
	CAPTURES_TABLE,
	type CaptureDocument,
	type CaptureFields,
	captureDefinition,
	composeBody,
	excerpt,
	parseCapture,
	unparsedCapture,
} from '@epicenter/capture';
import {
	type ImportReport,
	type LegacyBundle,
	runLegacyImport,
} from '@epicenter/capture/legacy';
import {
	type FileCapture,
	inspectRow,
	rowPath,
	type TableWriteReceipt,
} from '@epicenter/folder';
import { createSubscriber, SvelteMap } from 'svelte/reactivity';
import {
	type CaptureEntry,
	type Current,
	createDraft,
	type Draft,
	type DraftStore,
	type Notice,
	UNENCODABLE,
} from './draft.svelte.js';
import type { CaptureHost } from './platform/types.js';

export type CaptureRow = {
	readonly stem: string;
	readonly path: string;
	/** `undefined` when the file's `capturedAt` is missing or not a date and time. */
	readonly capturedAt: Date | undefined;
	readonly preview: string;
	readonly thoughtCount: number;
	/** Why the text does not read as a capture, when it does not. */
	readonly problem: string | undefined;
	/** This page holds input for it that is not saved. */
	readonly unsettled: boolean;
	/** Why a draft this page holds is waiting for a choice. */
	readonly attention: Notice['kind'] | undefined;
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

function timeOf(reading: { readonly fields: Partial<CaptureFields> }) {
	// Undefined when the text does not parse or its `capturedAt` did not validate.
	const value = reading.fields.capturedAt;
	if (value === undefined) return undefined;
	const time = new Date(value);
	return Number.isNaN(time.getTime()) ? undefined : time;
}

/** Why a reading is not a capture, or undefined when it is. */
function problemOf(reading: {
	readonly parseError: { readonly message: string } | undefined;
	readonly issues: readonly { readonly message: string }[];
}): string | undefined {
	if (reading.parseError !== undefined) return reading.parseError.message;
	// No issues is no problem: joining none would read as an empty one.
	if (reading.issues.length === 0) return undefined;
	return reading.issues.map((issue) => issue.message).join('; ');
}

/** Refused: leaving or closing fenced every action. */
const FENCED = 'Capture is finishing its saves.';

export type Captures = ReturnType<typeof createCaptures>;

export function createCaptures(host: Pick<CaptureHost, 'folder' | 'location'>) {
	const { folder } = host;
	const table = folder.tables.captures;
	/** How the captures table reads text; it reads no file. */
	const inspect = (text: string) =>
		inspectRow(captureDefinition.tables.captures, text);

	let entries = $state.raw<readonly CaptureEntry[]>([]);
	let unreadable = $state.raw<
		readonly { readonly path: string; readonly message: string }[]
	>([]);
	/** Why the folder could not be listed, when it could not. */
	let listProblem = $state<string | undefined>();
	let loaded = $state(false);
	const drafts = new SvelteMap<string, Draft>();
	let newCapture = $state('');
	const trackGit = createSubscriber((update) => folder.git.subscribe(update));
	/** The Epicenter service that served this page has stopped. */
	let serviceStopped = $state(false);
	/** Leaving is deciding: nothing a person does is taken. */
	let leaving = $state(false);
	/** Closing began: nothing is taken again. */
	let closing: Promise<void> | undefined;
	let closed = $state(false);
	const fenced = () => leaving || closed;

	/** Moves when a create, copy, or import starts and when it ends. */
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
	/** Every action admitted and not yet settled: leaving and closing wait for all of them. */
	const admitted = new Set<Promise<void>>();
	function admit<T>(action: Promise<T>): Promise<T> {
		const settled = action.then(
			() => {},
			() => {},
		);
		admitted.add(settled);
		void settled.then(() => admitted.delete(settled));
		return action;
	}
	/** Wait for every admitted action, including any admitted meanwhile. */
	async function actions() {
		while (admitted.size > 0) await Promise.all(admitted);
	}
	async function writing<T>(work: () => Promise<T>): Promise<T> {
		writes++;
		try {
			return await work();
		} finally {
			writes++;
		}
	}

	async function read(stem: string): Promise<Current> {
		const { data: found, error: foundError } = await table.get(stem);
		if (foundError !== null)
			return { kind: 'unreadable', message: foundError.message };
		if (found === undefined) return { kind: 'removed' };
		return { kind: 'present', entry: found };
	}

	/**
	 * Write exact source as the capture at a stem, whose file must be absent.
	 * Resolves the entry of what was sent: the text of the submitted bytes, how
	 * the table reads that text, and the path and hash the folder returned.
	 *
	 * The text and its reading are settled before anything is published, and
	 * nothing is read back, so the entry acknowledges this write and is never
	 * what another program did at the path afterwards. Text with an unpaired
	 * surrogate is refused before it is encoded, because encoding would
	 * replace it: this is recovery text, and a copy must be exact.
	 */
	async function createExact(stem: string, text: string) {
		if (!text.isWellFormed())
			return {
				data: null,
				error: { name: 'Unencodable', message: UNENCODABLE },
			} as const;
		const reading = inspect(text);
		const { data: written, error: writtenError } = await writing(() =>
			folder.files.create(pathOf(stem), text),
		);
		if (writtenError !== null)
			return { data: null, error: writtenError } as const;
		const { path, sha256 } = written;
		const entry: CaptureEntry = Object.freeze({
			path,
			stem,
			text,
			sha256,
			...reading,
		});
		return { data: entry, error: null } as const;
	}

	/** A write receipt names the bytes sent; the entry is how they read. */
	const entryOf = (receipt: TableWriteReceipt): CaptureEntry =>
		Object.freeze({ ...receipt, ...inspect(receipt.text) });

	const storeFor = (stem: string): DraftStore => ({
		inspect,
		edit: (signal) => table.edit(stem, { signal }),
		read: () => read(stem),
		async create(source) {
			const created = await createExact(stem, source);
			if (created.error === null) noteSaved(created.data);
			return created;
		},
		remove: (reviewed) =>
			table.delete(reviewed.stem, { expectedSha256: reviewed.sha256 }),
		fenced,
	});

	function noteSaved(entry: CaptureEntry) {
		entries = [...entries.filter((other) => other.path !== entry.path), entry];
	}

	function draftOf(entry: CaptureEntry): Draft {
		let draft = drafts.get(entry.path);
		if (draft === undefined) {
			draft = createDraft(storeFor(entry.stem), {
				path: entry.path,
				stem: entry.stem,
			});
			drafts.set(entry.path, draft);
		}
		return draft;
	}

	/** Forget a draft: its editor is let go, and its admitted saves finish. */
	function drop(path: string, draft: Draft) {
		if (drafts.get(path) === draft) drafts.delete(path);
		draft.retire();
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
			const { data: listedEntries, error: listError } = listed;
			if (listError !== null) {
				listProblem = listError.message;
				return;
			}
			listProblem = undefined;
			loaded = true;
			// A file that was read is a capture to open, whether or not its text
			// parses. A file that could not be read has no text and is listed apart.
			entries = listedEntries.flatMap(({ result: { data } }) => data ?? []);
			unreadable = listedEntries.flatMap(({ path, result: { error } }) =>
				error ? { path, message: error.message } : [],
			);
			// A draft that holds nothing goes when its file is no longer listed,
			// or when it has no editor: opening it again reads the file afresh.
			// Open drafts keep their input; nothing here reads into them.
			const present = new Set(entries.map((entry) => entry.path));
			for (const [path, draft] of [...drafts])
				if (
					draft.opened &&
					!draft.unsettled &&
					(draft.refused !== undefined || !present.has(path))
				)
					drop(path, draft);
			return;
		}
	}

	/** Reread the folder. Calls made while one is running share one more pass. */
	function refresh(): Promise<void> {
		if (closed) return refreshing ?? Promise.resolve();
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

	/** One parse per distinct file text, for the timeline. */
	const parsed = new Map<string, CaptureDocument>();
	function documentOf(entry: CaptureEntry): CaptureDocument {
		const { text, parseError } = entry;
		let document = parsed.get(text);
		if (document === undefined) {
			if (parsed.size > 2000) parsed.clear();
			// Text and thoughts are read only from a file that parses as a capture.
			document =
				parseError === undefined
					? parseCapture(text)
					: unparsedCapture(text, parseError.message);
			parsed.set(text, document);
		}
		return document;
	}

	const rows = $derived.by((): CaptureRow[] => {
		const rowOf = (
			stem: string,
			path: string,
			draft: Draft | undefined,
			entry: CaptureEntry | undefined,
		): CaptureRow => {
			// An open capture reads as its draft shows it, saved or not, once its
			// editor is open; until then, as it was listed.
			const shown = draft?.loaded ? draft : undefined;
			const reading = shown?.reading ?? entry ?? inspect('');
			const document =
				shown?.document ??
				(entry ? documentOf(entry) : unparsedCapture('', ''));
			return {
				stem,
				path,
				capturedAt: timeOf(reading),
				preview: excerpt(document),
				thoughtCount: document.thoughts.length,
				problem: problemOf(reading),
				unsettled: draft?.unsettled ?? false,
				attention: draft?.notice?.kind,
			};
		};
		const list = entries.map((entry) =>
			rowOf(entry.stem, entry.path, drafts.get(entry.path), entry),
		);
		// A draft whose file is no longer listed (removed, or unreadable) still
		// holds input. It stays on the timeline so it can be reached and resolved.
		const listed = new Set(entries.map((entry) => entry.path));
		for (const [path, draft] of drafts)
			if (!listed.has(path))
				list.push(rowOf(draft.stem, path, draft, undefined));
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

	/**
	 * Settle what saves on its own: every admitted action, each draft's own
	 * file work, and every write already accepted. Resolves how many things
	 * would still be lost.
	 */
	async function settleAll(): Promise<number> {
		await actions();
		await Promise.all([...drafts.values()].map((draft) => draft.settle()));
		// A draft's work can finish an action it was part of, such as a delete.
		await actions();
		return unsettledDrafts().length + (newCapture === '' ? 0 : 1);
	}

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
			trackGit();
			return folder.git.snapshot;
		},
		/**
		 * The folder's owner closed it: nothing saves from this window again.
		 * The folder reports this itself, on its Git snapshot.
		 */
		get folderStopped() {
			trackGit();
			return folder.git.snapshot.closed;
		},
		get serviceStopped() {
			return serviceStopped;
		},
		/** Saving is the folder's and carries on; the page can load nothing more. */
		markServiceStopped() {
			serviceStopped = true;
		},
		/** Leaving or closing fenced every input and action. */
		get fenced() {
			return fenced();
		},
		get newCapture() {
			return newCapture;
		},
		inputNewCapture(value: string) {
			if (fenced()) return;
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
				(copying ? 1 : 0)
			);
		},
		refresh,

		/**
		 * The draft for a capture, opening one over its listed file if needed.
		 * Its editor opens in the background; `draft.opened` says when it has.
		 */
		open(stem: string): Draft | undefined {
			const path = pathOf(stem);
			const existing = drafts.get(path);
			if (existing !== undefined) return existing;
			if (closed) return undefined;
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
			if (fenced()) return { ok: false, message: FENCED };
			if (creating) return creating;
			const started = (async (): Promise<
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
						const { data: created, error: createdError } = await writing(() =>
							table.create({
								stem: newStem(now),
								fields: {
									capturedAt: now.toISOString() as CaptureFields['capturedAt'],
								},
								body,
							}),
						);
						if (createdError === null) {
							noteSaved(entryOf(created));
							if (newCapture === text) newCapture = '';
							return { ok: true, stem: created.stem };
						}
						// Another capture took this name: a new one is tried.
						const taken = createdError.name === 'Exists';
						if (!taken || attempt >= 3)
							return { ok: false, message: createdError.message };
					}
				} catch (cause) {
					return { ok: false, message: describe(cause) };
				}
			})().finally(() => {
				creating = undefined;
			});
			creating = admit(started);
			return creating;
		},

		/**
		 * Save a draft's source as a new capture with an exclusive create, and
		 * let go of the draft without saving it to its own file. For a draft
		 * whose save failed or was not confirmed, whose file is gone, or whose
		 * delete was not confirmed. Its own file is left as it is.
		 *
		 * The copy is the source only: the editor's latest input. Text typed
		 * but not yet in the source
		 * (a new thought, a thought being edited, capture text that was refused)
		 * would be dropped with the draft, so the copy is refused while any
		 * exists, and nothing is written. The draft is held while the copy is
		 * written, so the copy is all of it.
		 */
		async saveCopy(
			draft: Draft,
		): Promise<{ ok: true; stem: string } | { ok: false; message: string }> {
			if (fenced()) return { ok: false, message: FENCED };
			if (copying)
				return { ok: false, message: 'A copy is already being saved.' };
			if (draft.hasUnsentInput)
				return {
					ok: false,
					message:
						'A copy holds the capture as it is in Source. This capture also has text you typed that is not in it yet: a new thought, a thought you are editing, or capture text that could not be applied. Add it, or copy it somewhere and clear it, then save the copy.',
				};
			const started = (async (): Promise<
				{ ok: true; stem: string } | { ok: false; message: string }
			> => {
				const result = await draft.copying(async (source) => {
					try {
						const stem = `${newStem(new Date())}-copy`;
						const { data: created, error: createdError } = await createExact(
							stem,
							source,
						);
						if (createdError !== null)
							return { ok: false, message: createdError.message } as const;
						// Listed as it was written; the refresh below says what is there now.
						noteSaved(created);
						return { ok: true, stem } as const;
					} catch (cause) {
						return { ok: false, message: describe(cause) } as const;
					}
				});
				if (result === undefined)
					return { ok: false, message: 'This capture is busy.' };
				if (result.ok) {
					drop(draft.path, draft);
					void refresh();
				}
				return result;
			})().finally(() => {
				copying = undefined;
			});
			copying = admit(started);
			return copying;
		},

		/** Let go of a draft and its input without writing anything. */
		async discard(draft: Draft): Promise<void> {
			if (fenced() || !draft.admitted || draft.saving) return;
			drop(draft.path, draft);
			await refresh();
		},

		/**
		 * Hold the draft, settle it, and read its file as it is now for the
		 * person to review before deleting it. The review stays on the draft,
		 * above any view, until it is confirmed or cancelled. Resolves whether
		 * there is a file to review; the draft says why when there is not.
		 */
		reviewDeletion(draft: Draft): Promise<boolean> {
			if (fenced()) return Promise.resolve(false);
			return admit(draft.reviewDeletion());
		},
		/**
		 * Delete exactly the file the person reviewed, without reading it again.
		 * Refused while leaving or closing, and for a draft already let go.
		 * Once admitted it runs to its answer, wherever the views are; done, the
		 * draft is let go here. Resolves whether it deleted.
		 */
		remove(draft: Draft): Promise<boolean> {
			if (fenced() || draft.retired) return Promise.resolve(false);
			const reviewed = draft.deletionReview?.entry;
			return admit(
				draft.confirmDeletion().then((deleted) => {
					if (deleted && reviewed !== undefined) {
						drop(draft.path, draft);
						entries = entries.filter((entry) => entry.path !== reviewed.path);
					}
					return deleted;
				}),
			);
		},

		/** Import the whole export, including its report, receipt, and fresh listing. */
		importLegacy(bundle: LegacyBundle): Promise<ImportReport> {
			if (fenced()) return Promise.reject(new Error(FENCED));
			if (importing) return importing;
			const started = (async () => {
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
			importing = admit(started);
			return importing;
		},
		commit: () => folder.git.commit(),

		/**
		 * The page's part in leaving Epicenter. `fence` runs before anything is
		 * awaited; `settle` resolves how many things would be lost; `resume`
		 * gives every draft back as it was.
		 */
		departure: {
			fence() {
				leaving = true;
			},
			settle: settleAll,
			resume() {
				leaving = false;
			},
		},

		/**
		 * Finish intended saves before the page releases its folder: every
		 * submitted action and every write already accepted. Failed saves are
		 * not sent again. Then each draft lets go of its editor.
		 */
		close(): Promise<void> {
			if (closing) return closing;
			closed = true;
			closing = (async () => {
				try {
					await settleAll();
					await refreshing;
				} finally {
					for (const [path, draft] of [...drafts]) drop(path, draft);
				}
			})();
			return closing;
		},
	};
}
