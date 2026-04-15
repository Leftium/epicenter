/**
 * IndexedDB-specific type definitions for Dexie schema migrations.
 *
 * These types represent historical and current storage formats used exclusively
 * by the web (IndexedDB) storage layer. They are NOT domain types — the app-wide
 * intermediate representation is the `Recording` type in `../models/recordings.ts`.
 *
 * @see {@link ../models/recordings.ts} for the domain type used by UI and services
 */
import type { DbRecording } from '../models/recordings';

/**
 * Serialized audio format for IndexedDB storage.
 *
 * This format is used to work around iOS Safari's limitations with storing Blob objects
 * in IndexedDB. Instead of storing the Blob directly (which can fail or become corrupted
 * on iOS), we deconstruct it into:
 * - arrayBuffer: The raw binary data
 * - blobType: The original MIME type (e.g., 'audio/webm', 'audio/wav')
 *
 * This can be reliably stored in IndexedDB on all platforms, including iOS Safari.
 * To reconstruct: new Blob([arrayBuffer], { type: blobType })
 */
export type SerializedAudio = {
	arrayBuffer: ArrayBuffer;
	blobType: string;
};

type RecordingStoredInIndexedDbLegacy = {
	id: string;
	title: string;
	subtitle: string;
	timestamp: string;
	createdAt: string;
	updatedAt: string;
	transcribedText: string;
	transcriptionStatus: 'UNPROCESSED' | 'TRANSCRIBING' | 'DONE' | 'FAILED';
	serializedAudio: SerializedAudio | undefined;
};

/**
 * How a recording is actually stored in IndexedDB (storage format).
 *
 * New writes use the V2 recording field names. Existing IndexedDB rows may still carry
 * legacy V1/V4-style names until they are read and rewritten, so the storage type accepts
 * both shapes.
 */
export type RecordingStoredInIndexedDB =
	| (DbRecording & {
			serializedAudio: SerializedAudio | undefined;
	  })
	| RecordingStoredInIndexedDbLegacy;

export type RecordingsDbSchemaV5 = {
	recordings: RecordingStoredInIndexedDB;
};

export type RecordingsDbSchemaV4 = {
	recordings: RecordingsDbSchemaV3['recordings'] & {
		// V4 added 'createdAt' and 'updatedAt' fields
		createdAt: string;
		updatedAt: string;
	};
};

export type RecordingsDbSchemaV3 = {
	recordings: RecordingsDbSchemaV1['recordings'];
};

export type RecordingsDbSchemaV2 = {
	recordingMetadata: Omit<RecordingsDbSchemaV1['recordings'], 'blob'>;
	recordingBlobs: { id: string; blob: Blob | undefined };
};

export type RecordingsDbSchemaV1 = {
	recordings: {
		id: string;
		title: string;
		subtitle: string;
		timestamp: string;
		transcribedText: string;
		blob: Blob | undefined;
		/**
		 * A recording
		 * 1. Begins in an 'UNPROCESSED' state
		 * 2. Moves to 'TRANSCRIBING' while the audio is being transcribed
		 * 3. Finally is marked as 'DONE' when the transcription is complete.
		 * 4. If the transcription fails, it is marked as 'FAILED'
		 */
		transcriptionStatus: 'UNPROCESSED' | 'TRANSCRIBING' | 'DONE' | 'FAILED';
	};
};
