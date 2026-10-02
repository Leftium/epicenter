/**
 * Publishing one captured recording, and finishing a publication that stopped
 * partway.
 *
 * A capture is fixed before anything is written: its id, its bytes, and every
 * field its row will hold, including `audioPath`, the one place the audio's
 * path is recorded. The table owns only the row. The audio is an ordinary
 * file at that path, and no other file is looked for or treated as the
 * recording's because of its name.
 *
 * Both files are published as one folder batch: the audio first, then the
 * row. A folder on disk applies those as ordered steps, so a failure between
 * them leaves the audio saved with no row (`Partial`), and a lost reply
 * leaves the outcome unknown (`Unconfirmed`). The capture keeps its id and
 * bytes in the window through both, and every attempt starts by reading what
 * the folder has now:
 *
 * | The folder has                                   | The attempt |
 * | --- | --- |
 * | neither file                                     | creates the audio, then the row |
 * | exactly this capture's audio, and no row         | replaces the audio it read with the same bytes, then creates the row |
 * | this capture's row and exactly its audio         | is already published; writes nothing |
 * | another row, other audio, or the row without its audio | refuses and writes nothing |
 *
 * The replacement in the second case writes the bytes that are already
 * there. Its purpose is its condition: the batch lands only if the audio is
 * still exactly what was read, so the row is never created beside audio that
 * another writer changed in between.
 *
 * A complete batch receipt that covers both files proves they were published.
 * It does not say what the folder holds afterward, so the row is then read as
 * a new observation, to have a current entry to show and edit. These are two
 * facts and they are reported apart:
 *
 * - The row reads back as this recording: `saved`, with that entry.
 * - The read fails, or the row is gone or is no longer this recording:
 *   `published`. The save happened. What is wrong is the current observation,
 *   and the only thing done about it is to read again (`observePublication`).
 *   Nothing is published a second time, and a row another writer removed or
 *   changed after publication is not recreated or repaired.
 *
 * `Partial`, `Unconfirmed`, and a refusal before publication are not
 * confirmed publications. They stay unresolved, and a retry of one starts
 * from the table above.
 */
import {
	type BatchReceipt,
	hashBytes,
	type Entry,
	type FileCapture,
	type FileTable,
	type FolderFiles,
	rowPath,
} from '@epicenter/folder';
import { RECORDINGS, type RecordingFields } from '../definition.js';
import type {
	RecordingPublicationHook,
	WhisperingFolder,
} from '../workspace/types.js';

export type RecordingEntry = Entry<RecordingFields>;

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
 * The two files a complete batch receipt says this capture published, as the
 * captures of the bytes that were submitted. It is evidence of what was
 * written, not a reading of the folder: no entry or baseline is made from it.
 */
export type ConfirmedPublication = {
	readonly audio: FileCapture;
	readonly row: FileCapture;
};

/** The row of a published recording, as the folder has it at one moment. */
export type PublicationObservation =
	| { readonly status: 'present'; readonly entry: RecordingEntry }
	/** The read failed. Nothing is known about the row now. */
	| { readonly status: 'unreadable'; readonly message: string }
	/** No row is there. Another writer removed it after publication. */
	| { readonly status: 'missing'; readonly message: string }
	/** A row is there and is not this recording. Another writer changed it. */
	| { readonly status: 'foreign'; readonly message: string };

export type PublishOutcome =
	| {
			readonly status: 'saved';
			readonly entry: RecordingEntry;
			/** Whether this attempt completed or confirmed an earlier one. */
			readonly recovered: boolean;
	  }
	/**
	 * Both files were published, and the row could not then be shown as this
	 * recording. That is a problem with the current observation, not with the
	 * save: nothing is unsaved, and nothing is published again for it.
	 */
	| {
			readonly status: 'published';
			readonly publication: ConfirmedPublication;
			readonly problem: Exclude<PublicationObservation, { status: 'present' }>;
	  }
	/** Some files reached the folder and some did not. Retry completes it. */
	| {
			readonly status: 'partial';
			readonly landed: readonly string[];
			readonly message: string;
	  }
	/** Publication failed or was not confirmed. Retry reads the folder first. */
	| { readonly status: 'failed'; readonly message: string }
	/** The folder holds something at a path that is not this capture's. Nothing was written. */
	| {
			readonly status: 'unexpected';
			readonly path: string;
			readonly message: string;
	  };

export type PublishTarget = {
	readonly tables: {
		readonly recordings: Pick<FileTable<RecordingFields>, 'get'>;
	};
	readonly files: Pick<FolderFiles, 'read'>;
	readonly batch: WhisperingFolder['batch'];
};

function occupied(path: string): PublishOutcome {
	return {
		status: 'unexpected',
		path,
		message: `${path} already exists and is not this recording. Nothing was overwritten.`,
	};
}

/**
 * Whether a row is this capture's recording: a valid row with the capture's
 * own facts. The title and notes are the person's to change, and fields the
 * app does not declare are not part of a capture, so neither is compared.
 */
function isThisRecording(entry: RecordingEntry, capture: PendingCapture) {
	return (
		entry.issues === undefined &&
		entry.fields.recordedAt === capture.fields.recordedAt &&
		entry.fields.durationMs === capture.fields.durationMs &&
		entry.fields.capture === capture.fields.capture &&
		entry.fields.audioPath === capture.fields.audioPath
	);
}

/**
 * What a receipt confirms was published, when it names the two writes this
 * attempt asked for with these audio bytes. Undefined when it does not.
 */
function confirmedBy(
	receipt: BatchReceipt,
	audioPath: string,
	audio: string,
	row: string,
): ConfirmedPublication | undefined {
	const [first, second] = receipt.steps;
	if (
		receipt.steps.length !== 2 ||
		first?.kind !== 'write' ||
		first.path !== audioPath ||
		!(first.file.sha256 === audio) ||
		second?.kind !== 'write' ||
		second.path !== row
	)
		return undefined;
	return { audio: first.file, row: second.file };
}

/**
 * `around` runs the batch. It exists for a debug desktop shell, which puts an
 * armed failure in the batch's way; everywhere else the batch simply runs. It
 * is given only the batch, so an attempt that publishes nothing never reaches
 * it.
 */
export async function publishRecording(
	target: PublishTarget,
	capture: PendingCapture,
	around: RecordingPublicationHook = (_recording, publish) => publish(),
): Promise<PublishOutcome> {
	const table = target.tables.recordings;
	const { audioPath } = capture.fields;
	const row = rowPath(RECORDINGS, capture.id);
	const pendingVersion = await hashBytes(capture.bytes);

	const existing = await table.get(capture.id);
	if (existing.error)
		return { status: 'failed', message: existing.error.message };
	if (existing.data !== undefined && !isThisRecording(existing.data, capture))
		return occupied(row);

	const audio = await target.files.read(audioPath);
	if (audio.error && audio.error.name !== 'NotFound')
		return { status: 'failed', message: audio.error.message };
	const observedAudio = audio.error ? undefined : audio.data;
	if (observedAudio !== undefined && !(observedAudio.sha256 === pendingVersion))
		return occupied(audioPath);

	if (existing.data !== undefined) {
		if (observedAudio === undefined)
			return {
				status: 'unexpected',
				path: audioPath,
				message: `${row} is this recording, but its audio ${audioPath} is not in the folder. Nothing was written.`,
			};
		return { status: 'saved', entry: existing.data, recovered: true };
	}

	const published = await around(
		{
			stem: capture.id,
			audioPath: observedAudio === undefined ? audioPath : undefined,
		},
		() =>
			target.batch((batch) => {
				if (observedAudio === undefined)
					batch.files.create(audioPath, capture.bytes);
				// The audio from an earlier attempt is in place. Writing the same bytes
				// over exactly what was read makes the row's creation conditional on it.
				else
					batch.files.replace(
						{ path: observedAudio.path, sha256: observedAudio.sha256 },
						capture.bytes,
					);
				batch.tables.recordings.create({
					stem: capture.id,
					fields: capture.fields,
					body: capture.body,
				});
			}),
	);

	if (published.error) {
		const error = published.error;
		switch (error.name) {
			case 'Partial':
				return {
					status: 'partial',
					landed: error.applied.map((step) =>
						step.kind === 'move' ? step.to : step.path,
					),
					message: error.error.message,
				};
			// Refused before publication: another writer took a path after it was read.
			case 'Exists':
				return occupied(error.path);
			case 'Collision':
				return {
					status: 'unexpected',
					path: error.existing,
					message: `${error.message}. Nothing was written.`,
				};
			case 'Conflict':
				return {
					status: 'unexpected',
					path: error.path,
					message: `${error.message}. Nothing was overwritten.`,
				};
			default:
				return { status: 'failed', message: error.message };
		}
	}
	const publication = confirmedBy(
		published.data,
		audioPath,
		pendingVersion,
		row,
	);
	if (publication === undefined)
		return {
			status: 'failed',
			message:
				'The folder answered without confirming this recording’s files. Trying again checks what it holds.',
		};

	// From here the publication is a fact: the receipt covers both files. What
	// the folder holds now is a separate question, and no answer to it, and no
	// failure to get one, turns a completed publication into a failed one.
	const observed = await observePublication(target, capture);
	if (observed.status === 'present')
		return {
			status: 'saved',
			entry: observed.entry,
			recovered: observedAudio !== undefined,
		};
	return { status: 'published', publication, problem: observed };
}

/**
 * Read a published recording's row as the folder has it now. This only
 * reads. It is how a publication whose row could not be shown is looked at
 * again: nothing is published, recreated, or repaired, whatever is found.
 *
 * A row that is this recording is returned as the current observation, with
 * any title or notes the person has changed since. A row that is gone, or is
 * no longer this recording, was changed by another writer after publication
 * and is left as it is.
 */
export async function observePublication(
	target: Pick<PublishTarget, 'tables'>,
	capture: PendingCapture,
): Promise<PublicationObservation> {
	const row = rowPath(RECORDINGS, capture.id);
	const read = await target.tables.recordings.get(capture.id);
	if (read.error)
		return {
			status: 'unreadable',
			message: `${row} could not be read: ${read.error.message}`,
		};
	if (read.data === undefined)
		return {
			status: 'missing',
			message: `${row} is no longer in the folder. It was removed after this recording was saved.`,
		};
	if (!isThisRecording(read.data, capture))
		return {
			status: 'foreign',
			message: `${row} was changed after this recording was saved and is no longer this recording.`,
		};
	return { status: 'present', entry: read.data };
}
