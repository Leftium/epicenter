/**
 * Publishing one captured recording, and recovering a publication that
 * stopped partway.
 *
 * A capture has an identity before anything is written: its id names both
 * `recordings/<id>.<extension>` and `recordings/<id>.md`. A native folder
 * writes the audio first and the row second as two filesystem steps, so a
 * failure between them leaves the audio saved with no row. The capture keeps
 * its id and bytes in memory, and every attempt starts by looking at what is
 * in the folder now:
 *
 * - nothing there: publish audio and row together;
 * - exactly this capture's audio, byte for byte, and no row: write only the
 *   missing row, as an exclusive creation;
 * - this capture's row and audio both there: already published, so succeed
 *   without writing;
 * - anything else at those paths: refuse and write nothing. Recovery never
 *   replaces a row or audio file it cannot prove it wrote.
 *
 * Retrying therefore keeps the recording's identity and cannot create a
 * second recording.
 */
import {
	captureVersion,
	type Entry,
	type FileTable,
	type FolderFiles,
	type FolderGit,
	patchSource,
	rowPath,
	sameVersion,
} from '@epicenter/app/files';
import { RECORDINGS, type RecordingFields } from '../definition.js';

export type RecordingEntry = Entry<RecordingFields>;

export type PendingCapture = {
	/** The row stem and the audio file's stem. Fixed when the capture ended. */
	readonly id: string;
	readonly bytes: Uint8Array;
	readonly extension: string;
	readonly fields: RecordingFields;
};

export type PublishOutcome =
	| {
			readonly status: 'saved';
			readonly entry: RecordingEntry;
			/** Whether this attempt completed or confirmed an earlier one. */
			readonly recovered: boolean;
	  }
	/** Some files reached the folder and some did not. Retry completes it. */
	| {
			readonly status: 'partial';
			readonly landed: readonly string[];
			readonly message: string;
	  }
	/** Nothing was written by this attempt. Retry repeats it. */
	| { readonly status: 'failed'; readonly message: string }
	/** A file this capture did not write occupies its path. Nothing was written. */
	| {
			readonly status: 'unexpected';
			readonly path: string;
			readonly message: string;
	  };

export type PublishTarget = {
	readonly tables: { readonly recordings: FileTable<RecordingFields> };
	readonly files: Pick<FolderFiles, 'children' | 'read' | 'write'>;
	readonly git: Pick<FolderGit, 'commit'>;
};

export function audioPathOf(capture: PendingCapture): string {
	return `${RECORDINGS}/${capture.id}.${capture.extension}`;
}

/** Files in `recordings/` that a row with this stem would own as its attachment. */
function sameStemFiles(filenames: readonly string[], id: string): string[] {
	return filenames.filter((filename) => {
		const dot = filename.lastIndexOf('.');
		if (dot <= 0 || filename.slice(0, dot) !== id) return false;
		const extension = filename.slice(dot + 1);
		return /^[A-Za-z0-9]+$/.test(extension) && extension.toLowerCase() !== 'md';
	});
}

function unexpected(path: string): PublishOutcome {
	return {
		status: 'unexpected',
		path,
		message: `${path} already exists and is not this recording. Nothing was overwritten.`,
	};
}

/** The row source a table would compose: declared fields in order, empty notes. */
function rowSource(fields: RecordingFields) {
	return patchSource('', {
		fields: {
			title: fields.title,
			recordedAt: fields.recordedAt,
			durationMs: fields.durationMs,
			capture: fields.capture,
		},
	});
}

export async function publishRecording(
	target: PublishTarget,
	capture: PendingCapture,
): Promise<PublishOutcome> {
	const table = target.tables.recordings;
	const audioPath = audioPathOf(capture);
	const row = rowPath(RECORDINGS, capture.id);

	const existing = await table.get(capture.id);
	if (existing.error)
		return { status: 'failed', message: existing.error.message };
	const listed = await target.files.children(RECORDINGS);
	if (listed.error && listed.error.name !== 'NotFound')
		return { status: 'failed', message: listed.error.message };
	const candidates = sameStemFiles(listed.data?.files ?? [], capture.id).map(
		(filename) => `${RECORDINGS}/${filename}`,
	);

	/** Whether the only same-stem file is this capture's audio, byte for byte. */
	async function audioIsMine(): Promise<boolean | { message: string }> {
		if (candidates.length !== 1 || candidates[0] !== audioPath) return false;
		const read = await target.files.read(audioPath);
		if (read.error) return { message: read.error.message };
		return sameVersion(read.data.version, await captureVersion(capture.bytes));
	}

	if (existing.data !== undefined) {
		const mine = await audioIsMine();
		if (typeof mine === 'object')
			return { status: 'failed', message: mine.message };
		const entry = existing.data;
		const sameRow =
			entry.issues === undefined &&
			entry.fields.recordedAt === capture.fields.recordedAt &&
			entry.fields.capture === capture.fields.capture;
		if (mine && sameRow) return { status: 'saved', entry, recovered: true };
		return unexpected(sameRow ? (candidates[0] ?? audioPath) : row);
	}

	if (candidates.length === 0) {
		const created = await table.create({
			stem: capture.id,
			fields: capture.fields,
			body: '',
			attachment: { extension: capture.extension, bytes: capture.bytes },
		});
		if (created.error === null)
			return { status: 'saved', entry: created.data, recovered: false };
		if (created.error.name === 'Partial')
			return {
				status: 'partial',
				landed: created.error.applied.map((step) =>
					step.kind === 'move' ? step.to : step.path,
				),
				message: created.error.error.message,
			};
		return { status: 'failed', message: created.error.message };
	}

	const mine = await audioIsMine();
	if (typeof mine === 'object')
		return { status: 'failed', message: mine.message };
	if (!mine) return unexpected(candidates[0]!);

	// The audio from an earlier attempt is in place. Only the row is missing.
	const source = rowSource(capture.fields);
	if (source.error) return { status: 'failed', message: source.error.reason };
	const written = await target.files.write(row, source.data, {
		expected: 'absent',
	});
	if (written.error)
		return {
			status: 'partial',
			landed: [audioPath],
			message: written.error.message,
		};
	// A raw write requests no commit, and this one completes a managed save.
	void target.git.commit();
	const saved = await table.get(capture.id);
	if (saved.error) return { status: 'failed', message: saved.error.message };
	if (saved.data === undefined)
		return {
			status: 'failed',
			message: `${row} was removed right after it was written`,
		};
	return { status: 'saved', entry: saved.data, recovered: true };
}
