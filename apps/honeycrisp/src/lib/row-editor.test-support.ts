/**
 * A row editor over a file a test holds, for tests that must hold, fail, or
 * lose a save's reply at an exact moment.
 *
 * A test cannot reach the real editor's storage: `table.edit` saves through
 * the folder's own storage, and no opener takes injected storage. This double
 * follows the folder's documented editor contract (see `@epicenter/folder`'s
 * README, "Editing a row") for flat frontmatter: a canonical form with
 * declared keys first, every key quoted and every value in JSON; a save is
 * one unconditional write of it; a clean editor follows a valid read; a read
 * never resets dirty input; an unconfirmed save stays unconfirmed after a
 * read finds its content. The folder's tests cover the real editor; tests
 * that need no fault use it.
 */
import {
	FileError,
	hashBytes,
	type RowEditor,
	RowEditorError,
	type RowEditorState,
	type RowObservation,
	type RowRevision,
	type RowSaveAttempt,
	type RowSaveOutcome,
	type TableReading,
} from '@epicenter/folder';
import { Err, Ok } from 'wellcrafted/result';

type Document = RowEditorState<unknown>['document'];
type Fields = Record<string, unknown>;

/** What the file holds, and how a write of it is answered. */
export type FakeRowFile = {
	read(): string | undefined | Promise<string | undefined>;
	/** Write `source` over the file. A reply with an error names its kind. */
	write(source: string): Promise<{ error?: { name: string; message: string } }>;
	/** Called with a function that requests a read, as a change hint does. */
	watch?(hint: () => void): () => void;
};

/** Parse simple frontmatter: `key: value` lines, values as JSON when they read as JSON. */
function parse(source: string): Document | undefined {
	const match = /^---\r?\n([\s\S]*?)^---\r?\n?/m.exec(source);
	if (match === null || match.index !== 0) return undefined;
	const fields: Fields = {};
	for (const line of (match[1] ?? '').split(/\r?\n/)) {
		if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
		const colon = line.indexOf(':');
		if (colon < 0) return undefined;
		const rawKey = line.slice(0, colon).trim();
		const rawValue = line.slice(colon + 1).trim();
		const key = rawKey.startsWith('"') ? (JSON.parse(rawKey) as string) : rawKey;
		let value: unknown;
		try {
			value = JSON.parse(rawValue);
		} catch {
			value = rawValue;
		}
		fields[key] = value;
	}
	return {
		fields: fields as Document['fields'],
		body: source.slice(match[0].length),
	};
}

/** A value in JSON flow style, spaced as the folder's canonical form spaces it. */
function flow(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(flow).join(', ')}]`;
	if (typeof value === 'object' && value !== null)
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}: ${flow((value as Fields)[key])}`)
			.join(', ')}}`;
	return JSON.stringify(value);
}

function format(document: Document, declared: readonly string[]): string {
	const keys = Object.keys(document.fields);
	const ordered = [
		...declared.filter((key) => keys.includes(key)),
		...keys.filter((key) => !declared.includes(key)).sort(),
	];
	const lines = ordered.map(
		(key) =>
			`${JSON.stringify(key)}: ${flow((document.fields as Fields)[key])}\n`,
	);
	return `---\n${lines.join('')}---\n${document.body}`;
}

const sha = (source: string) => hashBytes(new TextEncoder().encode(source));

/** Open a fake editor on `path`, as `table.edit` does: refused unless the file is a valid row. */
export async function openFakeRowEditor<TFields>({
	path,
	declared,
	inspect,
	file,
}: {
	path: string;
	declared: readonly string[];
	inspect: (source: string) => TableReading<TFields>;
	file: FakeRowFile;
}) {
	async function readRow(): Promise<RowObservation<TFields>> {
		const source = await file.read();
		if (source === undefined) return { kind: 'missing' };
		const sha256 = await sha(source);
		const document = parse(source);
		const reading = inspect(source);
		if (
			document === undefined ||
			reading.parseError !== undefined ||
			reading.issues.length > 0
		)
			return { kind: 'invalid', file: { path, sha256, source }, reading };
		return {
			kind: 'present',
			revision: {
				path,
				sha256,
				source,
				document,
				canonical: format(document, declared),
			},
		};
	}

	const first = await readRow();
	if (first.kind === 'missing') return FileError.NotFound({ path });
	if (first.kind !== 'present')
		return first.kind === 'invalid'
			? RowEditorError.InvalidSource({ file: first.file, reading: first.reading })
			: FileError.NotFound({ path });

	type State = RowEditorState<TFields>;
	let state: State = {
		path,
		baseline: first.revision,
		document: first.revision.document,
		source: first.revision.canonical,
		reading: inspect(first.revision.canonical),
		isDirty: false,
		observation: first,
		saving: undefined,
		lastSave: undefined,
		isDisposed: false,
	};
	const listeners = new Set<(state: State) => void>();
	let admitted: Promise<unknown> | undefined;
	let disposal: Promise<void> | undefined;

	function update(patch: Partial<State>) {
		state = { ...state, ...patch };
		for (const listener of [...listeners]) listener(state);
	}

	function follow(revision: RowRevision): Partial<State> {
		return {
			baseline: revision,
			document: revision.document,
			source: revision.canonical,
			reading: inspect(revision.canonical),
			isDirty: false,
		};
	}

	async function refresh() {
		if (state.isDisposed) return;
		const observation = await readRow();
		if (state.isDisposed) return;
		if (state.saving !== undefined || observation.kind !== 'present')
			return update({ observation });
		const { revision } = observation;
		if (revision.sha256 === state.baseline.sha256)
			return update({ observation });
		if (!state.isDirty || revision.canonical === state.source)
			return update({ ...follow(revision), observation });
		update({ observation });
	}

	const stopWatching = file.watch?.(() => void refresh()) ?? (() => {});

	const editor = {
		get: (): State => state,
		subscribe(listener: (state: State) => void) {
			listeners.add(listener);
			listener(state);
			return () => {
				listeners.delete(listener);
			};
		},
		change(change: { fields?: Fields; body?: string }) {
			if (state.isDisposed) return RowEditorError.Disposed({ path });
			const fields: Fields = { ...(state.document.fields as Fields) };
			for (const [key, value] of Object.entries(change.fields ?? {}))
				if (value === undefined) delete fields[key];
				else fields[key] = value;
			const document = {
				fields: fields as Document['fields'],
				body: change.body ?? state.document.body,
			};
			const source = format(document, declared);
			if (source === state.source) return Ok(undefined);
			update({
				document,
				source,
				reading: inspect(source),
				isDirty: source !== state.baseline.canonical,
			});
			return Ok(undefined);
		},
		async save() {
			if (state.isDisposed) return RowEditorError.Disposed({ path });
			if (admitted !== undefined) return RowEditorError.Saving({ path });
			const { reading } = state;
			if (reading.parseError !== undefined || reading.issues.length > 0)
				return RowEditorError.InvalidDocument({ path, reading });
			const attempt: RowSaveAttempt = {
				path,
				document: state.document,
				source: state.source,
			};
			// Settles after the outcome is delivered, so disposal waits for it.
			const settled = Promise.withResolvers<void>();
			admitted = settled.promise;
			update({ saving: attempt });
			const sha256 = await sha(attempt.source);
			const { error } = await file.write(attempt.source);
			admitted = undefined;
			let outcome: RowSaveOutcome;
			if (error === undefined) {
				const receipt: RowRevision = {
					...attempt,
					sha256,
					canonical: attempt.source,
				};
				outcome = { kind: 'saved', receipt };
				update({
					baseline: receipt,
					isDirty: state.source !== receipt.canonical,
					saving: undefined,
					lastSave: outcome,
				});
			} else {
				const cause = new Error(error.message);
				outcome =
					error.name === 'Unconfirmed'
						? {
								kind: 'unconfirmed',
								attempt,
								error: FileError.Unconfirmed({
									path,
									operation: 'publishing to',
									cause,
								}).error,
							}
						: {
								kind: 'failed',
								attempt,
								error: FileError.Io({ path, operation: 'write', cause })
									.error,
							};
				update({ saving: undefined, lastSave: outcome });
			}
			settled.resolve();
			void refresh();
			return outcome.kind === 'saved'
				? Ok(outcome.receipt)
				: Err(outcome.error);
		},
		refresh,
		adopt(reviewed: { path: string; canonical: string }) {
			if (state.isDisposed) return RowEditorError.Disposed({ path });
			if (admitted !== undefined) return RowEditorError.Saving({ path });
			const latest = state.observation;
			if (
				latest.kind !== 'present' ||
				reviewed.canonical !== latest.revision.canonical
			)
				return RowEditorError.Stale({ path, latest });
			update(follow(latest.revision));
			return Ok(undefined);
		},
		dispose() {
			if (disposal !== undefined) return disposal;
			// Listeners hear an admitted save settle, then are released.
			disposal = (admitted ?? Promise.resolve()).then(() => {
				listeners.clear();
			});
			stopWatching();
			update({ isDisposed: true });
			return disposal;
		},
	};
	return Ok(editor as unknown as RowEditor<TFields>);
}
