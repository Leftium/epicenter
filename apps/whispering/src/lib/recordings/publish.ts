/**
 * Publishing one captured recording as two independent writes, and finishing
 * one that stopped between them.
 *
 * A capture is fixed before anything is written: its id, its bytes, and every
 * field its row will hold, including `audioPath`, the one place the audio's
 * path is recorded. The table owns only the row. The audio is an ordinary
 * file at that path, and no other file is looked for or treated as the
 * recording's because of its name.
 *
 * The audio is written with `files.create`, then the row with
 * `tables.recordings.create`. Each is its own operation with its own answer:
 * the audio can land and the row fail, and nothing promises the audio stays
 * as it was between the two. Both creates are exclusive, so neither ever
 * replaces a file. The capture keeps its id and bytes in the window until the
 * row is in place.
 *
 * A first attempt writes without reading. A retry is asked for by the person,
 * and it reads the capture's two paths before it writes anything:
 *
 * | The folder has                                         | The retry |
 * | --- | --- |
 * | neither file                                           | creates the audio, then the row |
 * | exactly this capture's audio, and no row               | creates the row |
 * | this capture's row and exactly its audio               | writes nothing: the recording is there |
 * | other audio, another row, or the row without its audio | refuses and writes nothing |
 *
 * A create refused because its path is occupied reads what is there before
 * calling it anything: an earlier write of this capture whose reply was lost
 * can land after the attempt last looked. Exactly this capture's audio, or
 * this recording's row, is found and the attempt goes on; anything else is
 * another writer's and is left alone; a read that fails leaves it unknown.
 *
 * A receipt proves its own write: the bytes it was given landed. A read
 * proves only what is there now. What a retry finds is reported as found,
 * never as the confirmation of an earlier write whose reply was lost.
 */
import {
	type FileCapture,
	type FileTable,
	type FolderFiles,
	hashBytes,
	rowPath,
	type TableReading,
} from '@epicenter/folder';
import { RECORDINGS, type RecordingFields } from '../definition.js';
import type { RecordingWriteHook } from '../workspace/types.js';

export type PendingCapture = {
	/** The row's stem. Fixed when the capture ended. */
	readonly id: string;
	readonly bytes: Uint8Array;
	/** Every field the row will hold. `audioPath` is where `bytes` are saved. */
	readonly fields: RecordingFields;
	/** The row's Markdown body: the notes, empty for a new capture. */
	readonly body: string;
};

/**
 * How this window knows one of the capture's files is in the folder:
 * `receipt` when this attempt's create of exactly that content was
 * confirmed, `found` when a retry read it there. A found file says nothing
 * about which write put it there.
 */
export type InPlace = {
	readonly by: 'receipt' | 'found';
	readonly file: FileCapture;
};

/**
 * Whether a write that did not succeed may have landed: `failed` is the
 * folder's refusal or failure, `unknown` is a reply that never arrived.
 */
export type Certainty = 'failed' | 'unknown';

export type PublishOutcome =
	/** Both files are in place. */
	| {
			readonly kind: 'published';
			readonly audio: InPlace;
			readonly row: InPlace;
	  }
	/** The audio is not known to be in the folder. The row was not attempted. */
	| {
			readonly kind: 'audioNotSaved';
			readonly certainty: Certainty;
			readonly message: string;
	  }
	/** The audio is in place, and the row write did not succeed. */
	| {
			readonly kind: 'rowNotSaved';
			readonly certainty: Certainty;
			readonly audio: InPlace;
			readonly message: string;
	  }
	/**
	 * The folder holds something at one of the capture's paths that is not
	 * this recording's, or this recording's row without its audio. Nothing
	 * was written.
	 */
	| {
			readonly kind: 'refused';
			readonly path: string;
			readonly message: string;
	  }
	/** A retry could not read what the folder has, so it wrote nothing. */
	| { readonly kind: 'unchecked'; readonly message: string };

export type PublishTarget = {
	readonly tables: {
		readonly recordings: Pick<FileTable<RecordingFields>, 'get' | 'create'>;
	};
	readonly files: Pick<FolderFiles, 'read' | 'create'>;
};

/**
 * Whether a row's reading is this capture's recording: text that parses,
 * whose validated facts are the capture's own. The title and notes are the
 * person's to change, and fields the app does not declare are not part of a
 * capture, so neither is compared: a title that needs fixing does not make
 * the row another recording. A fact that did not validate is not the
 * capture's, and a row that does not parse states none.
 */
export function isThisRecording(
	reading: Pick<TableReading<RecordingFields>, 'fields' | 'parseError'>,
	capture: PendingCapture,
): boolean {
	const { fields } = reading;
	return (
		reading.parseError === undefined &&
		fields.recordedAt === capture.fields.recordedAt &&
		fields.durationMs === capture.fields.durationMs &&
		fields.capture === capture.fields.capture &&
		fields.audioPath === capture.fields.audioPath
	);
}

const refused = (path: string, message: string): PublishOutcome => ({
	kind: 'refused',
	path,
	message,
});
const occupied = (path: string) =>
	refused(
		path,
		`${path} already exists and is not this recording. Nothing was overwritten.`,
	);

/**
 * Run one write through `around`, as an answer. Folder writes report their
 * failures as results, so a throw is not one of their outcomes: it is caught
 * here only so the capture and what is already known about it are not lost
 * with it, and it is reported as an unknown outcome.
 */
async function write<T>(
	around: RecordingWriteHook,
	target: Parameters<RecordingWriteHook>[0],
	run: () => Promise<T>,
): Promise<{ readonly answer: T } | { readonly thrown: string }> {
	try {
		return { answer: await around(target, run) };
	} catch (cause) {
		return { thrown: cause instanceof Error ? cause.message : String(cause) };
	}
}

const certaintyOf = (error: { readonly name: string }): Certainty =>
	error.name === 'Unconfirmed' ? 'unknown' : 'failed';

/**
 * Read the capture's two paths before a retry writes anything. Returns the
 * audio found in place, or the outcome that ends the attempt here.
 */
async function inspect(
	target: PublishTarget,
	capture: PendingCapture,
): Promise<
	| { readonly kind: 'clear'; readonly audio: InPlace | undefined }
	| PublishOutcome
> {
	const { audioPath } = capture.fields;
	const row = rowPath(RECORDINGS, capture.id);

	const { data: existing, error: rowReadError } =
		await target.tables.recordings.get(capture.id);
	if (rowReadError !== null)
		return {
			kind: 'unchecked',
			message: `${row} could not be read, so nothing was written: ${rowReadError.message}`,
		};
	if (existing !== undefined && !isThisRecording(existing, capture))
		return occupied(row);

	const { data: audio, error: audioReadError } =
		await target.files.read(audioPath);
	if (audioReadError !== null && audioReadError.name !== 'NotFound')
		return {
			kind: 'unchecked',
			message: `${audioPath} could not be read, so nothing was written: ${audioReadError.message}`,
		};
	const found =
		audioReadError !== null
			? undefined
			: { path: audio.path, sha256: audio.sha256 };
	if (found !== undefined && found.sha256 !== (await hashBytes(capture.bytes)))
		return occupied(audioPath);

	if (existing === undefined)
		return {
			kind: 'clear',
			audio: found && { by: 'found', file: found },
		};
	// Audio removed after its row landed is not recreated: the row is there,
	// and putting its audio back is the person's decision, not a retry's.
	if (found === undefined)
		return refused(
			audioPath,
			`${row} is this recording, but its audio ${audioPath} is not in the folder. Nothing was written.`,
		);
	return {
		kind: 'published',
		audio: { by: 'found', file: found },
		row: {
			by: 'found',
			file: { path: existing.path, sha256: existing.sha256 },
		},
	};
}

/**
 * One attempt to publish a capture. `retry` is set for an attempt the person
 * asked for: it reads the folder first and finishes only what is missing.
 * `around` runs each write; a debug desktop shell puts an armed failure in
 * that one write's way. A write the attempt does not make never reaches it.
 */
export async function publishRecording(
	target: PublishTarget,
	capture: PendingCapture,
	{
		retry,
		around = (_write, run) => run(),
	}: { retry: boolean; around?: RecordingWriteHook },
): Promise<PublishOutcome> {
	const { audioPath } = capture.fields;
	const row = rowPath(RECORDINGS, capture.id);

	let audio: InPlace | undefined;
	if (retry) {
		const found = await inspect(target, capture);
		if (found.kind !== 'clear') return found;
		audio = found.audio;
	}

	if (audio === undefined) {
		const created = await write(
			around,
			{ step: 'audio', stem: capture.id, path: audioPath },
			() => target.files.create(audioPath, capture.bytes),
		);
		if ('thrown' in created)
			return {
				kind: 'audioNotSaved',
				certainty: 'unknown',
				message: created.thrown,
			};
		const { data: written, error: writeError } = created.answer;
		if (writeError?.name === 'Exists') {
			// Something is there now. An earlier write of this capture whose
			// reply was lost may have landed since the attempt last looked, so
			// what is there is read before it is called anything.
			const { data: there, error: readError } =
				await target.files.read(audioPath);
			if (readError !== null)
				return {
					kind: 'audioNotSaved',
					certainty: 'unknown',
					message: `${audioPath} was occupied when this recording's audio was written, and could not then be read, so whether it is this recording's audio is not known: ${readError.message}`,
				};
			if (there.sha256 !== (await hashBytes(capture.bytes)))
				return occupied(audioPath);
			audio = {
				by: 'found',
				file: { path: there.path, sha256: there.sha256 },
			};
		} else if (writeError !== null) {
			return {
				kind: 'audioNotSaved',
				certainty: certaintyOf(writeError),
				message: writeError.message,
			};
		} else audio = { by: 'receipt', file: written };
	}

	const created = await write(around, { step: 'row', stem: capture.id }, () =>
		target.tables.recordings.create({
			stem: capture.id,
			fields: capture.fields,
			body: capture.body,
		}),
	);
	if ('thrown' in created)
		return {
			kind: 'rowNotSaved',
			certainty: 'unknown',
			audio,
			message: created.thrown,
		};
	const { data: written, error: writeError } = created.answer;
	if (writeError?.name === 'Exists') {
		// As for the audio: the row there may be this capture's own, landed late.
		const { data: there, error: readError } =
			await target.tables.recordings.get(capture.id);
		if (readError !== null || there === undefined)
			return {
				kind: 'rowNotSaved',
				certainty: 'unknown',
				audio,
				message: `${row} was occupied when this recording's row was written, and could not then be read, so whether it is this recording's row is not known${readError !== null ? `: ${readError.message}` : '.'}`,
			};
		if (!isThisRecording(there, capture))
			return {
				kind: 'rowNotSaved',
				certainty: 'failed',
				audio,
				message: `${row} already exists and is not this recording. Nothing was overwritten.`,
			};
		return {
			kind: 'published',
			audio,
			row: {
				by: 'found',
				file: { path: there.path, sha256: there.sha256 },
			},
		};
	}
	if (writeError !== null)
		return {
			kind: 'rowNotSaved',
			certainty: certaintyOf(writeError),
			audio,
			message: writeError.message,
		};
	return {
		kind: 'published',
		audio,
		row: {
			by: 'receipt',
			file: { path: written.path, sha256: written.sha256 },
		},
	};
}
