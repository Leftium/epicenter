/**
 * A live Table: one folder on disk, read as one typed table.
 *
 * The folder is the truth and other processes write it (agents, your editor, git),
 * so the table is not a one-shot read: a single `watch_folder` command arms a
 * native folder watcher (backed by `notify`), pushes the folder's current
 * contents as a first batch, then streams a batch per debounced change. Each
 * pushed delta is self-contained ({@link FileDelta}: a file name plus the file's
 * observable state), so the JS never round-trips a separate read. External
 * updates, the seed scan, AND the app's own successful writes all flow through
 * ONE path (`applyDeltas`) into ONE `SvelteMap`.
 *
 * Lifecycle: opening a table IS observing it, so the watcher starts at
 * construction. `whenReady` resolves once it is armed (the seed scan has run, so
 * the store holds the folder's current contents) and rejects if it cannot be, which
 * the UI gates on with `{#await}`. `dispose()` stops the OS watch and retires body controls. The keyed route
 * component (`/vault/[id]`) owns one table's lifetime, constructing it on mount and
 * disposing it on destroy, so no module singleton or standing effect drives the
 * watcher; the set of open vaults is just a persisted list (`open-vaults.svelte.ts`).
 * A Vault that composes many tables (one per child folder) is the next layer up;
 * see the vault-as-relational-unit spec.
 *
 * The table also owns body input a person has typed ({@link BodyEditor}): the store
 * above stays a projection of disk, and accepted body text lives beside it for the
 * table's lifetime, so closing the row dialog or switching tables keeps it.
 *
 * Desktop-only: it talks to Tauri directly (no platform seam). Develop with
 * `bun run tauri dev`.
 */

import {
	basename,
	buildView,
	editBody,
	editField,
	loadContract,
	MatterReadError,
	parseEntry,
	parseMarkdown,
	type Row,
	type TableRead,
	type UnreadableFile,
} from '@epicenter/matter-core';
import { Channel, invoke } from '@tauri-apps/api/core';
import { SvelteMap } from 'svelte/reactivity';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';
// One file's observable state, pushed by `watch_folder` (content / removed /
// unreadable). Generated from the Rust `FileDelta` enum by ts-rs, so the IPC payload
// has one source of truth; regenerate with `cargo test` in `src-tauri`.
import type { FileDelta } from './bindings/FileDelta';

/** Why a write did not reach disk, in words a person can act on. */
type WriteFailure = { message: string };

/**
 * Where one file's accepted body stands against the file. `changed` means the
 * accepted body differs from the observed file version; Discard returns to the observed file version.
 */
export type BodyStatus =
	| { kind: 'saved' }
	| { kind: 'saving'; reason?: string }
	| { kind: 'failed'; reason: string }
	| { kind: 'changed' };

/**
 * One file's body as an editor: the accepted body and the commands over it.
 * `set` accepts a complete replacement at once and saves it; the table keeps
 * the accepted body until `discard`, whatever the file or its watcher echoes do.
 */
export type BodyEditor = {
	readonly fileName: string;
	/** Accepted input, else the file's body; undefined when there is neither. */
	readonly body: string | undefined;
	readonly status: BodyStatus;
	set(body: string): void;
	/** Save the accepted body again after a failure. */
	retry(): void;
	/** Discard accepted input and show the last observed file body. Ignored while saving. */
	discard(): void;
};

const writeFailed = (cause: unknown) =>
	Err({ message: extractErrorMessage(cause) });

/**
 * The body write for the freshest bytes. `editBody` hands back unparseable text
 * unchanged, which would pass for a landed save, so the parse is checked here;
 * a missing file stays missing rather than being recreated.
 */
function replaceBody(
	raw: string | null,
	body: string,
): Result<string, WriteFailure> {
	if (raw === null) return Err({ message: 'The file no longer exists' });
	const { error } = parseMarkdown(raw);
	if (error) return Err({ message: error.message });
	return Ok(editBody(raw, body));
}

/**
 * Open `path` as a live table. Synchronous and IO-free: the store starts empty
 * and fills from the first pushed batch once `watch()` runs, so there is no
 * separate initial read and no read-then-watch gap.
 *
 * `onChange` is invoked at the end of each applied watcher batch — the Vault
 * passes an adapter that projects this one table into the shared `.matter`
 * mirror. The Table owns no SQLite itself; the callback keeps the rebuild trigger
 * imperative and at its source (the batch), not laundered through a reactive effect.
 */
export function createTable(path: string, onChange: () => void) {
	const folderName = basename(path);

	// ONE store, keyed by filename: each entry is a `Result` that is either a
	// parsed row or the error that stopped it. `set` replaces, so "a name is
	// readable XOR unreadable" is structural, not an invariant kept by hand across
	// two maps.
	const files = new SvelteMap<string, Result<Row, UnreadableFile['error']>>();
	let contractText = $state<string | undefined>(undefined);
	// Set when the LAST field save could not reach disk. Body saves report through
	// their own editor (`bodyEditor`), which also keeps the text that failed.
	let writeError = $state<string | undefined>(undefined);
	// Memoized: Schema.Compile runs only when matter.json changes, not on every
	// .md change. A single-file change reclassifies against these cached columns.
	const loaded = $derived(loadContract(contractText));

	/** Apply one pushed batch to the store (the seed and every update). */
	function applyDeltas(deltas: FileDelta[]) {
		for (const delta of deltas) {
			if (delta.fileName === 'matter.json') {
				// A removed or unreadable matter.json is no contract: degrade to the raw view.
				contractText = delta.kind === 'content' ? delta.text : undefined;
				continue;
			}
			switch (delta.kind) {
				case 'content':
					files.set(delta.fileName, parseEntry(delta.fileName, delta.text));
					break;
				case 'removed':
					files.delete(delta.fileName);
					break;
				case 'unreadable':
					// `Undecodable()` already returns an `Err`, so it stores directly as
					// the file's failed `Result` (no row, the read-level error).
					files.set(delta.fileName, MatterReadError.Undecodable());
					break;
			}
		}
		// One signal per applied batch: the Vault's adapter projects this table into the
		// shared `.matter` mirror (off the UI task; the grid is already current from the map
		// mutations above). Per-batch, not debounced: the native watcher already coalesces a
		// burst into one batch. The Table itself touches no SQLite.
		onChange();
	}

	/**
	 * The current classified folder, derived from the files map + the loaded contract.
	 * The ONE place "files map -> TableRead" lives, MEMOIZED so the `read` getter (the UI
	 * surface) and the Vault's mirror adapter (which reads `read` in its deferred rebuild)
	 * share a single classification instead of each recomputing it. Recomputes only when
	 * `files` or the loaded contract changes.
	 */
	const read = $derived.by((): TableRead => {
		const rows: TableRead['rows'] = [];
		const unreadable: TableRead['unreadable'] = [];
		for (const [fileName, { data, error }] of files) {
			if (error) unreadable.push({ fileName, error });
			else rows.push(data);
		}
		return { rows, unreadable, view: buildView(rows, loaded) };
	});

	/**
	 * Serialize writes to one file. A folder edit is read-modify-write (read the
	 * freshest bytes, transform, atomic-write), so two writes to the SAME file must
	 * run in order or the second reads stale bytes and drops the first's change.
	 * Different files still write in parallel; the per-file chain is pruned when it
	 * drains, so the map does not grow with the folder.
	 */
	const writeTails = new Map<string, Promise<unknown>>();
	function serializeWrite<T>(
		fileName: string,
		run: () => Promise<T>,
	): Promise<T> {
		const tail = (writeTails.get(fileName) ?? Promise.resolve()).then(run);
		const settled = tail.catch(() => {});
		writeTails.set(fileName, settled);
		void settled.then(() => {
			if (writeTails.get(fileName) === settled) writeTails.delete(fileName);
		});
		return tail;
	}

	/**
	 * Apply one edit to a file on disk: read the freshest bytes, transform them in
	 * JS, write atomically, then feed the result straight back through `applyDeltas`.
	 * A command in the CQRS sense: it writes the file (the truth) and applies ITS OWN
	 * result on success, rather than waiting ~300ms for the change to echo back
	 * through the watcher. The watcher's later echo re-applies identical bytes
	 * (harmless), and EXTERNAL edits still arrive only through it, so the map equals
	 * disk after every settled write without sitting on a round-trip.
	 *
	 * Reading at write time (rather than caching raw text in the store) keeps the
	 * edit faithful to the current bytes and keeps the store a parsed read-model with
	 * no second copy to drift. `edit` receives `null` for a missing file and may
	 * refuse; a refused or failed write leaves the map untouched (we apply only on
	 * success) and returns why.
	 */
	function write(
		fileName: string,
		edit: (raw: string | null) => Result<string, WriteFailure>,
	): Promise<Result<undefined, WriteFailure>> {
		return serializeWrite(fileName, async () => {
			const read = await tryAsync({
				try: () => invoke<string | null>('read_entry', { path, fileName }),
				catch: writeFailed,
			});
			if (read.error) return read;
			const edited = edit(read.data);
			if (edited.error) return edited;
			const written = await tryAsync({
				try: () =>
					invoke('write_entry', { path, fileName, content: edited.data }),
				catch: writeFailed,
			});
			if (written.error) return written;
			applyDeltas([{ kind: 'content', fileName, text: edited.data }]);
			return Ok(undefined);
		});
	}

	/**
	 * Set or clear one frontmatter field (`value === undefined` clears it). The
	 * transform ({@link editField}) is applied to the FRESH bytes on disk, not the
	 * in-memory projection, so a concurrent external edit to another field is read,
	 * not clobbered. Writes to one file are serialized, so two quick edits cannot
	 * interleave their read-modify-write and drop one of the changes. A failure
	 * surfaces in `writeError` until the next field save lands.
	 */
	async function saveField(
		fileName: string,
		key: string,
		value: unknown,
	): Promise<void> {
		const { error } = await write(fileName, (raw) =>
			trySync({
				try: () => editField(raw ?? '', key, value),
				catch: writeFailed,
			}),
		);
		writeError = error?.message;
	}

	/** The file's body on disk, or undefined when it is not a readable row. */
	function diskBody(fileName: string): string | undefined {
		return files.get(fileName)?.data?.body;
	}

	/**
	 * Body input this table accepted, per file, kept until Discard drops it. Only a
	 * landed write or a watcher batch changes `files`, and neither replaces an
	 * entry here: an earlier save, or its late echo, cannot overwrite newer typing,
	 * and a failed save keeps its text. Lives as long as the table, so a closed
	 * dialog or a switch to another table keeps it; closing the vault does not.
	 */
	const acceptedBodies = new SvelteMap<string, AcceptedBody>();
	type AcceptedBody = ReturnType<typeof acceptBody>;

	/** Accept `initial` for `fileName` and start saving it. */
	function acceptBody(fileName: string, initial: string) {
		let body = $state(initial);
		let saving = $state(false);
		let failure = $state<string>();

		/**
		 * Write until the file holds the latest accepted body. One write runs at a
		 * time; input accepted during it waits, and only the newest is written next.
		 * The written body is read when the write reads the file, not when it queued.
		 */
		async function save(): Promise<void> {
			saving = true;
			let written: string;
			try {
				do {
					written = body;
					const { error } = await write(fileName, (raw) => {
						written = body;
						return replaceBody(raw, written);
					});
					failure = error?.message;
				} while (!disposed && body !== written);
			} finally {
				// A throw past `write` must not leave the body stuck as saving, which
				// would ignore every later input, Try again, and Discard.
				saving = false;
			}
		}
		void save();

		return {
			get body() {
				return body;
			},
			get saving() {
				return saving;
			},
			get failure() {
				return failure;
			},
			set(next: string): void {
				if (next === body) return;
				body = next;
				if (!saving) void save();
			},
			retry(): void {
				if (!saving) void save();
			},
		};
	}

	/** The editor for one file's body. Holds no state itself; the table does. */
	function bodyEditor(fileName: string): BodyEditor {
		return {
			fileName,
			get body() {
				return acceptedBodies.get(fileName)?.body ?? diskBody(fileName);
			},
			get status(): BodyStatus {
				const accepted = acceptedBodies.get(fileName);
				if (!accepted) return { kind: 'saved' };
				if (accepted.saving)
					return { kind: 'saving', reason: accepted.failure };
				if (accepted.failure !== undefined)
					return { kind: 'failed', reason: accepted.failure };
				return accepted.body === diskBody(fileName)
					? { kind: 'saved' }
					: { kind: 'changed' };
			},
			set(body: string): void {
				if (disposed) return;
				const accepted = acceptedBodies.get(fileName);
				if (accepted) accepted.set(body);
				else if (body !== diskBody(fileName))
					acceptedBodies.set(fileName, acceptBody(fileName, body));
			},
			retry(): void {
				if (disposed) return;
				acceptedBodies.get(fileName)?.retry();
			},
			discard(): void {
				if (disposed || acceptedBodies.get(fileName)?.saving) return;
				acceptedBodies.delete(fileName);
			},
		};
	}

	/** Retained bodies that differ from disk or failed publication, by file name. */
	const unsavedBodies = $derived(
		[...acceptedBodies]
			.filter(
				([fileName, accepted]) =>
					accepted.failure !== undefined ||
					(!accepted.saving && accepted.body !== diskBody(fileName)),
			)
			.map(([fileName]) => bodyEditor(fileName))
			.sort((a, b) => a.fileName.localeCompare(b.fileName)),
	);

	// Opening a vault IS observing it: arm the OS watcher now. `watch_folder` seeds the store
	// with the folder's current contents, then streams a batch per change, all through
	// `applyDeltas`. `whenReady` resolves once the watch is armed (the seed scan finishes
	// before `watch_folder` resolves, so even an empty folder resolves rather than hanging)
	// and rejects if it cannot be armed; the UI gates on it with `{#await}`.
	const channel = new Channel<FileDelta[]>();
	channel.onmessage = applyDeltas;
	let watchId: number | undefined;
	let disposed = false;
	const whenReady = invoke<number>('watch_folder', { path, channel }).then(
		(id) => {
			// Disposed before the id arrived: drop the watcher that just resolved.
			if (disposed) void invoke('unwatch_folder', { id });
			else watchId = id;
		},
	);
	/** Stop the OS watch. The keyed route component calls this when it is torn down (a table switch or vault close). */
	function dispose(): void {
		disposed = true;
		if (watchId !== undefined) void invoke('unwatch_folder', { id: watchId });
	}

	return {
		folderName,
		path,
		saveField,
		bodyEditor,
		dispose,
		/** Resolves once the OS watcher is armed (the folder is being observed), with the
		 *  seed contents already applied; rejects if it could not be armed. */
		whenReady,
		/** The current classified folder. A pure read with no side effects. */
		get read(): TableRead {
			return read;
		},
		/** Set if the most recent field save could not reach disk. */
		get writeError(): string | undefined {
			return writeError;
		},
		/** Retained bodies needing attention, including files no dialog can open. */
		get unsavedBodies(): BodyEditor[] {
			return unsavedBodies;
		},
	};
}

export type TableHandle = ReturnType<typeof createTable>;

/**
 * The slice of a {@link TableHandle} the grid renders from: the folder name, the
 * classified read, field saves, and body editors. This is the narrow dependency boundary
 * `TableGrid` depends on, NOT the full table handle, so the grid cannot reach the
 * watcher lifecycle (`whenReady` / `dispose` / `path`) it has no business touching,
 * and a `Pick` of the live handle satisfies it for free.
 */
export type TableView = Pick<
	TableHandle,
	'folderName' | 'read' | 'saveField' | 'bodyEditor'
>;
