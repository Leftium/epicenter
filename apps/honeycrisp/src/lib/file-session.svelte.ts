/**
 * One open raw file's editing session, and the folder calls every file change
 * goes through. A structured note is not a raw file: its row editor saves it
 * (`row-session.svelte.ts`). A note whose text the row editor cannot hold is
 * repaired here, as text.
 *
 * A session keeps these facts apart:
 *
 * - `saved` is the capture this session last agreed is in the file: its path,
 *   the sha256 of its bytes, and the text those bytes are. It is the
 *   baseline the next replace, move, or remove is conditional on.
 * - `buffer` is the text on screen, including unsaved typing.
 * - `attempt` is exactly what a write submitted: the path, the text, and the
 *   condition. It is `sent` until the folder replies, and `unconfirmed` when
 *   the reply cannot say whether the write happened. Its text is the text of
 *   the bytes that were sent, which differs from the typed string only where
 *   encoding replaced an unpaired surrogate, so it is what a read of those
 *   bytes returns.
 * - `pathChange` is a move or a removal of this file that was submitted: the
 *   capture it named and, for a move, the destination. It is kept when its
 *   outcome is unknown, or when a move kept its source.
 * - `external` is what an observation found on disk that this session has not
 *   agreed with. Each observation of new bytes is a new object, so a review
 *   names one by identity and a later observation cannot change its target.
 *
 * What a reply or an observation may conclude:
 *
 * - A successful write acknowledges the submitted text at the capture the
 *   folder returned. Nothing is read to confirm it, and typing during the
 *   write stays dirty. A buffer that is the same bytes as the saved text
 *   shows the saved text, so it is not dirty and is not sent again.
 * - A refusal wrote nothing. `saved` and `external` are left as they are until
 *   a read says otherwise.
 * - A failed or unconfirmed write is kept (`failure`, or `attempt` as
 *   `unconfirmed`) until the person chooses, and nothing is saved by itself
 *   meanwhile: no timer, no typing, no settle, and no close sends anything.
 *   The choices are a new attempt of what is on screen now (`retry`),
 *   keeping the file as it was last read (`keepFile`, or `takeTheirs` on a
 *   reviewed version), or saving over a reviewed version (`saveMine`).
 * - A read describes the file now and nothing about an earlier write. Text
 *   the session already holds, on screen or in an unconfirmed write, becomes
 *   `saved` when a read finds it: that is what the file holds. An unconfirmed
 *   write stays unconfirmed all the same; even exact bytes do not show which
 *   command put them there. Other text is recorded beside it as `external`.
 * - A move or removal whose outcome is unknown, or a move that could not
 *   remove its source, is kept. Nothing is saved, moved, or concluded from a
 *   read while it stands, and the session is not forgotten. There is no retry
 *   and no cleanup: nothing here can show which file the session should go
 *   on with, and nothing writes its old path again.
 *
 * Every write is conditional on a capture, so a command that lands late is
 * refused by its own condition or shows up as a change to review. The
 * condition is the folder's: on a real directory it compares the bytes it
 * reads just before replacing them, which another program can still race.
 */
import type {
	FileCapture,
	FileError,
	FolderFiles,
	MoveError,
} from '@epicenter/folder';
import type { Result } from 'wellcrafted/result';
import { type Capture, readTextFile, submittedText } from './files.js';

// ============================================================================
// The folder calls
// ============================================================================

/** What the folder said about one requested change. */
export type FileOutcome<T = undefined> =
	| { readonly kind: 'done'; readonly value: T }
	| {
			/** The condition did not hold, and nothing was written. */
			readonly kind: 'refused';
			readonly message: string;
			/** The path that already holds a file, when the condition was absence. */
			readonly occupied: string | undefined;
	  }
	| {
			/**
			 * `failed` changed nothing. `unconfirmed` may or may not have
			 * changed anything.
			 */
			readonly kind: 'failed' | 'unconfirmed';
			/** The library's name for the error. */
			readonly name: string;
			readonly message: string;
	  }
	| {
			/**
			 * A move put the bytes at `to` and could not remove `from`: both
			 * paths hold them now. Only a move ends this way.
			 */
			readonly kind: 'sourceNotRemoved';
			readonly from: string;
			readonly to: string;
			/**
			 * The capture of the bytes at `to`, when the move was guarded by a
			 * hash. A file move always is; an unguarded move names no hash.
			 */
			readonly moved: FileCapture | undefined;
			readonly message: string;
	  };

/** An error a folder or table call can reply with. */
type Reply<T> = Result<
	T,
	FileError | MoveError | { readonly name: string; readonly message: string }
>;

/**
 * Read the folder's reply. Every changing call in this module goes through
 * here, and so does a table call whose errors share these names.
 */
export async function ask<T>(
	call: () => Promise<Reply<T>>,
): Promise<FileOutcome<T>> {
	let result: Reply<T>;
	try {
		result = await call();
	} catch (cause) {
		// A call that threw never said whether it wrote.
		return {
			kind: 'unconfirmed',
			name: 'Thrown',
			message: cause instanceof Error ? cause.message : String(cause),
		};
	}
	const { data, error } = result;
	if (error === null) return { kind: 'done', value: data as T };
	if ('moved' in error && error.name === 'SourceNotRemoved')
		return {
			kind: 'sourceNotRemoved',
			from: error.from,
			to: error.to,
			moved: error.moved,
			message: error.message,
		};
	if (error.name === 'Conflict' || error.name === 'Exists')
		return {
			kind: 'refused',
			message: error.message,
			occupied:
				error.name === 'Exists' &&
				'path' in error &&
				typeof error.path === 'string'
					? error.path
					: undefined,
		};
	return {
		kind: error.name === 'Unconfirmed' ? 'unconfirmed' : 'failed',
		name: error.name,
		message: error.message,
	};
}

/**
 * Save `text` as a file that must not exist yet. The capture's source is the
 * text of the bytes that were sent.
 */
export async function createFile(
	files: Pick<FolderFiles, 'create'>,
	path: string,
	text: string,
): Promise<FileOutcome<Capture>> {
	const { bytes, text: source } = submittedText(text);
	const created = await ask(() => files.create(path, bytes));
	return created.kind === 'done'
		? { kind: 'done', value: { ...created.value, text: source } }
		: created;
}

/**
 * Save `text` over a file only while it still holds the captured bytes. The
 * capture's source is the text of the bytes that were sent.
 */
export async function replaceFile(
	files: Pick<FolderFiles, 'replace'>,
	base: FileCapture,
	text: string,
): Promise<FileOutcome<Capture>> {
	const { bytes, text: source } = submittedText(text);
	const replaced = await ask(() => files.replace(base, bytes));
	return replaced.kind === 'done'
		? { kind: 'done', value: { ...replaced.value, text: source } }
		: replaced;
}

/**
 * Move the captured bytes to a path that must not exist yet. A move is two
 * steps on every backend; `sourceNotRemoved` means the bytes reached the
 * destination and the original is still there.
 */
export function moveFile(
	files: Pick<FolderFiles, 'move'>,
	file: FileCapture,
	to: string,
): Promise<FileOutcome<FileCapture>> {
	return ask(() => files.move(file, to));
}

/** Remove a file only while it still holds the captured bytes. */
export function removeFile(
	files: Pick<FolderFiles, 'remove'>,
	file: FileCapture,
): Promise<FileOutcome> {
	return ask(() => files.remove(file));
}

/** Make a directory. A reply that never comes is `unconfirmed`, as for a file. */
export function makeDirectory(
	files: Pick<FolderFiles, 'mkdir'>,
	path: string,
): Promise<FileOutcome> {
	return ask(() => files.mkdir(path));
}

/** Remove an empty directory. */
export function removeDirectory(
	files: Pick<FolderFiles, 'rmdir'>,
	path: string,
): Promise<FileOutcome> {
	return ask(() => files.rmdir(path));
}

// ============================================================================
// The session
// ============================================================================

/** What a fresh read of the path found. */
export type Observed =
	| { readonly kind: 'present'; readonly file: Capture }
	| { readonly kind: 'removed' }
	| { readonly kind: 'unreadable'; readonly message: string };

/** What is on disk that the session has not agreed with. */
export type External =
	| { readonly kind: 'changed'; readonly current: Capture }
	| { readonly kind: 'removed' }
	| { readonly kind: 'unreadable'; readonly message: string };

/**
 * One submitted write: where, what text, and on what condition. `source` is
 * the text of the bytes sent, so it encodes to exactly those bytes again.
 */
type Submission = { readonly path: string; readonly source: string } & (
	| { readonly kind: 'create' }
	| { readonly kind: 'replace'; readonly expectedSha256: string }
);

export type Attempt = Submission &
	(
		| { readonly state: 'sent' }
		| {
				/** The folder could not say whether this write happened. */
				readonly state: 'unconfirmed';
				readonly problem: string;
		  }
	);

/** One submitted move or removal of a session's file. */
export type PathStep =
	| {
			readonly kind: 'move';
			readonly from: FileCapture;
			readonly to: string;
	  }
	| { readonly kind: 'remove'; readonly from: FileCapture };

export type PathChange = PathStep &
	(
		| { readonly state: 'sent' }
		| {
				/**
				 * `unconfirmed`: it may or may not have happened.
				 * `sourceNotRemoved`: a move put the bytes at `to` and could not
				 * remove `from`, so both paths hold them.
				 */
				readonly state: 'unconfirmed' | 'sourceNotRemoved';
				readonly problem: string;
		  }
	);

/** A rename or delete that is not accounted for, as it stood when the person stopped tracking it. */
export type DetachedChange = Extract<
	PathChange,
	{ state: 'unconfirmed' | 'sourceNotRemoved' }
>;

export type SessionStatus =
	| 'saved'
	| 'dirty'
	| 'saving'
	| 'failed'
	| 'conflict'
	/** A write, move, or removal whose outcome is not known, or a move that kept its source. */
	| 'unconfirmed';

/** What an observation did to the session. */
export type ObserveOutcome =
	| 'same'
	/** A clean session took the file's new text. */
	| 'adopted'
	/**
	 * The file holds text this session already holds: it is the saved text
	 * now. An unconfirmed write stays unconfirmed.
	 */
	| 'agreed'
	| 'conflict'
	/** The file is gone and nothing was held; the owner may forget the session. */
	| 'gone'
	/** A write, move, or removal is running; the path is read again when it settles. */
	| 'deferred';

/** Typing batches for this long before a save. */
const TYPING_BATCH_MS = 500;

export type FileSession = ReturnType<typeof createFileSession>;

export function createFileSession(
	files: Pick<FolderFiles, 'read' | 'create' | 'replace' | 'move' | 'remove'>,
	initial: Capture,
	{
		onSaved = () => {},
		admits = () => true,
	}: {
		/** After this session's saved capture changed where or what it is. */
		onSaved?: () => void;
		/** Whether the person's input is being taken. False while a close is answered. */
		admits?: () => boolean;
	} = {},
) {
	let saved = $state.raw<Capture>(initial);
	let buffer = $state(initial.text);
	let attempt = $state.raw<Attempt | undefined>();
	let pathChange = $state.raw<PathChange | undefined>();
	let external = $state.raw<External | undefined>();
	/** Why the last write failed or was refused. Kept until the person chooses. */
	let failure = $state<string | undefined>();
	/**
	 * The rename or delete the person stopped tracking, as it stood: its
	 * outcome is not known, or a move kept its source, so this session's file
	 * is not known to be the one it edits. Nothing is saved by itself, and no
	 * read ends it, until the person chooses.
	 */
	let detached = $state.raw<DetachedChange | undefined>();
	let refusal = $state<string | undefined>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let recheck = false;
	let tail: Promise<unknown> = Promise.resolve();
	/**
	 * Replaced whenever the buffer is replaced by a file's text instead of by
	 * typing. A save captured before that belongs to text that is gone.
	 */
	let typedOver: object = {};

	const dirty = () => buffer !== saved.text;
	/**
	 * Nothing to review, nothing outstanding, and no failed or unconfirmed
	 * write waiting for the person: saving may run by itself.
	 */
	const idle = () =>
		external === undefined &&
		attempt === undefined &&
		pathChange === undefined &&
		failure === undefined &&
		detached === undefined;
	const unsettled = () => dirty() || !idle();

	function schedule() {
		clearTimeout(timer);
		if (!idle()) return;
		timer = setTimeout(() => void save(), TYPING_BATCH_MS);
	}

	/** One write, move, removal, or review choice at a time, in the order asked. */
	function exclusive<T>(work: () => Promise<T>): Promise<T> {
		const result = tail.then(work);
		tail = result.catch(() => {});
		return result;
	}

	async function read(path: string): Promise<Observed> {
		try {
			const { data: found, error: foundError } = await readTextFile(
				files,
				path,
			);
			if (foundError)
				return foundError.name === 'NotFound'
					? { kind: 'removed' }
					: { kind: 'unreadable', message: foundError.message };
			return found.kind === 'text'
				? { kind: 'present', file: found.file }
				: { kind: 'unreadable', message: 'The file is no longer text.' };
		} catch (cause) {
			return {
				kind: 'unreadable',
				message: cause instanceof Error ? cause.message : String(cause),
			};
		}
	}

	/**
	 * Show the saved text when the buffer is the same bytes. The two differ as
	 * strings only where encoding replaced an unpaired surrogate. The file can
	 * never hold that string, so it would stay dirty and be sent again without
	 * end. Typing that encodes to other bytes is left as it is.
	 */
	function showSaved() {
		if (buffer !== saved.text && submittedText(buffer).text === saved.text)
			buffer = saved.text;
	}

	/**
	 * Agree that `next` is what the file holds. No attempt is touched, and the
	 * buffer keeps every byte it has. A failure ends only when nothing on
	 * screen is unsaved any more.
	 */
	function agree(next: Capture) {
		saved = next;
		external = undefined;
		showSaved();
		if (!dirty()) failure = undefined;
	}

	function apply(observed: Observed): ObserveOutcome {
		// Where the file is, or whether it is, is not known: one read of one
		// path concludes nothing.
		if (pathChange !== undefined) return 'same';
		if (observed.kind === 'present') {
			const next = observed.file;
			if (next.path !== saved.path) return 'same';
			if (next.sha256 === saved.sha256) {
				// A conflict whose other side went back to what was agreed is over.
				if (external !== undefined) {
					external = undefined;
					if (dirty()) schedule();
				}
				return 'same';
			}
			clearTimeout(timer);
			// Text this session already holds, on screen or in a write whose
			// outcome is unknown: that is what the file holds now. It does not
			// show which write put it there, so an unconfirmed one stays.
			if (
				next.text === buffer ||
				(attempt?.state === 'unconfirmed' &&
					attempt.path === next.path &&
					attempt.source === next.text)
			) {
				agree(next);
				return 'agreed';
			}
			// A clean session follows the file. One with a write still out does
			// not, whatever its buffer holds: other text never becomes its base.
			if (!dirty() && attempt === undefined) {
				agree(next);
				buffer = next.text;
				refusal = undefined;
				typedOver = {};
				return 'adopted';
			}
			// The same bytes seen again are the same review target.
			if (
				!(
					external?.kind === 'changed' &&
					external.current.sha256 === next.sha256
				)
			)
				external = { kind: 'changed', current: next };
			return 'conflict';
		}
		clearTimeout(timer);
		if (observed.kind === 'removed') {
			// A session that still holds an attempt, a failure, or a rename or
			// delete the person stopped tracking is not forgotten by a read: the
			// file may be at the other path, and that is theirs to look at.
			if (
				!dirty() &&
				attempt === undefined &&
				failure === undefined &&
				detached === undefined
			)
				return 'gone';
			if (external?.kind !== 'removed') external = { kind: 'removed' };
			return 'conflict';
		}
		if (
			!(
				external?.kind === 'unreadable' && external.message === observed.message
			)
		)
			external = { kind: 'unreadable', message: observed.message };
		return 'conflict';
	}

	/** The one write. It records the attempt and changes nothing else. */
	function send(sent: Submission) {
		failure = undefined;
		attempt = { ...sent, state: 'sent' };
		const { path, source } = sent;
		return ask(() =>
			sent.kind === 'create'
				? files.create(path, source)
				: files.replace({ path, sha256: sent.expectedSha256 }, source),
		);
	}

	/**
	 * Take the folder's reply to `sent`.
	 *
	 * `prior` is an unconfirmed write this one was sent after. It stays on
	 * record when this one wrote nothing or is unknown too, because it may
	 * still land. A confirmed write supersedes it: the base it was conditional
	 * on is gone.
	 *
	 * `alternate` names another path for a first exclusive write that found
	 * its own path occupied by other text. A write sent after an unconfirmed
	 * one never gets one: that earlier write may be the occupant.
	 */
	async function conclude(
		sent: Submission,
		answer: FileOutcome<FileCapture>,
		prior: Attempt | undefined,
		alternate?: () => string,
	): Promise<void> {
		if (answer.kind === 'done') {
			// Only the submitted text is acknowledged, at the capture returned.
			agree({ ...answer.value, text: sent.source });
			// An earlier unconfirmed replace can still land only while the file
			// is the bytes it was conditional on. A write that left exactly those
			// bytes there does not end it.
			attempt =
				prior?.kind === 'replace' &&
				prior.expectedSha256 === answer.value.sha256
					? prior
					: undefined;
			failure = undefined;
			detached = undefined;
			onSaved();
		} else if (answer.kind === 'unconfirmed') {
			attempt = { ...sent, state: 'unconfirmed', problem: answer.message };
		} else if (answer.kind === 'refused') {
			recheck = false;
			const now = await read(sent.path);
			const ours = now.kind === 'present' && now.file.text === sent.source;
			if (
				alternate !== undefined &&
				prior === undefined &&
				sent.kind === 'create' &&
				!ours
			) {
				const elsewhere = { ...sent, path: alternate() };
				await conclude(elsewhere, await send(elsewhere), undefined);
				return;
			}
			attempt = prior;
			const before = external;
			const seen = sent.path === saved.path ? apply(now) : 'same';
			// Nothing new was learned about the file: say why the write was refused.
			if (seen !== 'agreed' && seen !== 'adopted' && external === before)
				failure = answer.message;
		} else {
			attempt = prior;
			failure = answer.message;
		}
		await settleRecheck();
		// Only a confirmed write goes on to save what was typed meanwhile.
		if (answer.kind === 'done' && dirty()) schedule();
	}

	/** An observation that arrived mid-operation may have been the operation's own. */
	async function settleRecheck() {
		if (!recheck) return;
		recheck = false;
		apply(await read(saved.path));
	}

	/**
	 * Save `text`, the buffer as it was when the save was asked for, over
	 * whatever this session agrees is saved when its turn comes. Nothing is
	 * sent unless saving may run by itself, and text whose bytes are already
	 * the saved ones is not sent.
	 */
	async function saveText(text: string, typed: object) {
		if (!idle() || typed !== typedOver || text === saved.text) return;
		const { text: source } = submittedText(text);
		if (source === saved.text) return showSaved();
		const sent: Submission = {
			kind: 'replace',
			path: saved.path,
			source,
			expectedSha256: saved.sha256,
		};
		await conclude(sent, await send(sent), undefined);
	}

	/** Save the current buffer if saving may run by itself. Resolves when this session's writes have settled. */
	function save(): Promise<void> {
		clearTimeout(timer);
		const source = buffer;
		const typed = typedOver;
		return exclusive(() => saveText(source, typed));
	}

	/**
	 * Settle the buffer, then run one move or removal of this file. Its
	 * outcome is kept when it is unknown, or when a move kept its source.
	 */
	function changePath<T>(
		step: (from: FileCapture) => PathStep,
		run: (from: FileCapture) => Promise<FileOutcome<T>>,
	): Promise<FileOutcome<T> | { readonly kind: 'unsettled' }> {
		// Not taken while input is fenced; the owner says why.
		if (!admits()) return Promise.resolve({ kind: 'unsettled' });
		clearTimeout(timer);
		const source = buffer;
		const typed = typedOver;
		return exclusive(async () => {
			await saveText(source, typed);
			if (unsettled()) return { kind: 'unsettled' } as const;
			const sent = step({ path: saved.path, sha256: saved.sha256 });
			pathChange = { ...sent, state: 'sent' };
			const answer = await run(sent.from);
			if (answer.kind === 'unconfirmed' || answer.kind === 'sourceNotRemoved') {
				pathChange = { ...sent, state: answer.kind, problem: answer.message };
			} else {
				pathChange = undefined;
				if (answer.kind === 'done' && sent.kind === 'move') {
					saved = { ...saved, path: sent.to };
					onSaved();
				} else if (answer.kind !== 'done') {
					// Refused or failed outright: nothing changed. See what is there.
					recheck = true;
				}
			}
			await settleRecheck();
			// Typing that arrived while the file was removed is not saved by itself.
			const removed = answer.kind === 'done' && sent.kind === 'remove';
			if (dirty() && !removed) schedule();
			return answer;
		});
	}

	function observe(observed: Observed): ObserveOutcome {
		if (attempt?.state === 'sent' || pathChange?.state === 'sent') {
			recheck = true;
			return 'deferred';
		}
		return apply(observed);
	}

	return {
		get saved() {
			return saved;
		},
		get buffer() {
			return buffer;
		},
		/** The write that is running, or one whose outcome is unknown. */
		get attempt() {
			return attempt;
		},
		/** The move or removal that is running, or one whose outcome is unknown or that kept its source. */
		get pathChange() {
			return pathChange;
		},
		get external() {
			return external;
		},
		/** Why the last write was refused or failed; kept until the person chooses. */
		get failure() {
			return failure;
		},
		/** The rename or delete the person stopped tracking, while it holds saving. */
		get detached() {
			return detached;
		},
		/** Why the last structured change was refused; typing clears it. */
		get refusal() {
			return refusal;
		},
		get dirty() {
			return dirty();
		},
		get path() {
			return saved.path;
		},
		get status(): SessionStatus {
			if (pathChange !== undefined)
				return pathChange.state === 'sent' ? 'saving' : 'unconfirmed';
			if (attempt !== undefined)
				return attempt.state === 'sent' ? 'saving' : 'unconfirmed';
			if (external !== undefined) return 'conflict';
			if (failure !== undefined || detached !== undefined) return 'failed';
			return dirty() ? 'dirty' : 'saved';
		},
		/**
		 * Whether leaving now could lose something: typing, an open change, a
		 * conflict, or a failed or unconfirmed write the person has not resolved.
		 */
		get unsettled() {
			return unsettled();
		},
		/** Whether the person's input and choices are being taken. */
		get admitting() {
			return admits();
		},
		/**
		 * Replace the whole buffer, as a source editor does. Returns false, and
		 * takes nothing, while input is fenced; a view must not show that text.
		 */
		input(text: string): boolean {
			if (!admits()) return false;
			buffer = text;
			refusal = undefined;
			schedule();
			return true;
		},
		/** Record that a requested change could not be applied; the buffer is unchanged. */
		refuse(reason: string) {
			refusal = reason;
		},
		save,
		/**
		 * Save again, as the person asked: a new write of the buffer as it is
		 * now, on the file this session agrees is saved, or a creation when the
		 * file is gone. It is never the earlier write sent again. An unconfirmed
		 * earlier write stays on record until this one is confirmed. A move or
		 * removal whose outcome is unknown has no retry.
		 */
		retry(): Promise<void> {
			if (!admits()) return Promise.resolve();
			clearTimeout(timer);
			const text = buffer;
			const typed = typedOver;
			return exclusive(async () => {
				if (pathChange !== undefined || typed !== typedOver) return;
				const prior = attempt?.state === 'unconfirmed' ? attempt : undefined;
				const { text: source } = submittedText(text);
				// Nothing differs from the file, and no outcome is in question. A
				// detached draft is still sent: its conditional write is what shows
				// the file is there as it was.
				if (
					prior === undefined &&
					detached === undefined &&
					external === undefined &&
					source === saved.text
				) {
					failure = undefined;
					showSaved();
					return;
				}
				const sent: Submission =
					external?.kind === 'removed'
						? { kind: 'create', path: saved.path, source }
						: {
								kind: 'replace',
								path: saved.path,
								source,
								expectedSha256: saved.sha256,
							};
				await conclude(sent, await send(sent), prior);
			});
		},
		/**
		 * The person's choice about a failed or unconfirmed write: keep the file
		 * as it was last read. The buffer becomes that text, so a draft that
		 * differs is discarded, and nothing is sent. The write's outcome is not
		 * concluded; it stops being held. Returns false while there is
		 * something else to choose first: a changed, removed, or unreadable
		 * file, or a move or removal that is not accounted for.
		 */
		keepFile(): boolean {
			if (!admits() || external !== undefined || pathChange !== undefined)
				return false;
			if (
				attempt?.state !== 'unconfirmed' &&
				failure === undefined &&
				detached === undefined
			)
				return false;
			clearTimeout(timer);
			attempt = undefined;
			failure = undefined;
			detached = undefined;
			buffer = saved.text;
			refusal = undefined;
			typedOver = {};
			return true;
		},
		/**
		 * Report a fresh read of this path. A clean session adopts changed bytes
		 * without writing; a dirty one keeps its buffer and records the other
		 * sha256. No read ends an unconfirmed write, and no read ends an unknown
		 * move or removal.
		 */
		observe,
		/**
		 * Read this path now and report what is there. A read that the session
		 * moved on from while it ran, by a save or a rename, is dropped.
		 */
		async reread(): Promise<ObserveOutcome> {
			const at = saved;
			const observed = await read(at.path);
			return saved === at ? observe(observed) : 'same';
		},
		/**
		 * Conflict choice: save my text over exactly the version I reviewed.
		 * `reviewed` is the `external` that was shown. Returns false, and writes
		 * nothing, when it is no longer the current one or something is still
		 * running.
		 *
		 * A reviewed `removed` or `unreadable` is saved as a new file at this
		 * path. `alternate` names another path to use when this one turns out to
		 * hold other text, unless an unconfirmed write may be the occupant.
		 */
		saveMine(reviewed: External, alternate?: () => string): Promise<boolean> {
			if (!admits() || reviewed !== external) return Promise.resolve(false);
			clearTimeout(timer);
			const text = buffer;
			return exclusive(async () => {
				if (
					reviewed !== external ||
					attempt?.state === 'sent' ||
					pathChange !== undefined
				)
					return false;
				const prior = attempt?.state === 'unconfirmed' ? attempt : undefined;
				const { text: source } = submittedText(text);
				const sent: Submission =
					reviewed.kind === 'changed'
						? {
								kind: 'replace',
								path: saved.path,
								source,
								expectedSha256: reviewed.current.sha256,
							}
						: { kind: 'create', path: saved.path, source };
				await conclude(
					sent,
					await send(sent),
					prior,
					prior === undefined ? alternate : undefined,
				);
				return true;
			});
		},
		/**
		 * Conflict choice: discard my text and take exactly the sha256 I
		 * reviewed. It also ends a failed or unconfirmed write: the person chose
		 * the file as it is. Returns false when it is no longer the current one
		 * or something is still running.
		 */
		takeTheirs(reviewed: External): boolean {
			if (
				!admits() ||
				reviewed !== external ||
				reviewed.kind !== 'changed' ||
				attempt?.state === 'sent' ||
				pathChange !== undefined
			)
				return false;
			clearTimeout(timer);
			agree(reviewed.current);
			buffer = reviewed.current.text;
			attempt = undefined;
			failure = undefined;
			detached = undefined;
			refusal = undefined;
			typedOver = {};
			return true;
		},
		/** Save pending input if saving may run by itself, and say whether nothing is left open. */
		async settle(): Promise<boolean> {
			await save();
			return !unsettled();
		},
		/**
		 * Rename or move the file. The move is conditional on the saved capture
		 * and on the destination not existing, so it never carries text this
		 * session has not seen. The session follows the file only on a `done`.
		 */
		move(to: string) {
			return changePath(
				(from) => ({ kind: 'move', from, to }),
				(from) => moveFile(files, from, to),
			);
		},
		/**
		 * Remove the file as `confirmed` captured it, which is what the person
		 * was shown when asked. A session that is not settled refuses, and the
		 * folder refuses a file that is no longer those bytes.
		 */
		remove(confirmed: FileCapture) {
			return changePath(
				() => ({ kind: 'remove', from: confirmed }),
				(from) => removeFile(files, from),
			);
		},
		/**
		 * Stop tracking a rename or removal whose outcome is not known, or a
		 * move that kept its source, as the person chose. Nothing is concluded
		 * about where the file is: the draft stays, nothing is saved by itself
		 * until the person chooses, and reads of this path count again. False
		 * when nothing is stuck.
		 */
		detach(): boolean {
			if (!admits() || pathChange === undefined || pathChange.state === 'sent')
				return false;
			detached = pathChange;
			pathChange = undefined;
			return true;
		},
		dispose() {
			clearTimeout(timer);
		},
	};
}
