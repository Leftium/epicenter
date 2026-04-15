/**
 * DB service's recording storage shape.
 *
 * This is NOT the domain Recording type (that lives in `$lib/workspace`). This type
 * describes what the storage adapters (file-system, IndexedDB) persist alongside audio
 * blobs. It exists because storage formats embed metadata for human readability (markdown
 * frontmatter) and backward compatibility (IndexedDB rows).
 *
 * Once the DB service is slimmed to audio-blob-only operations, this type can be removed.
 */
export type DbRecording = {
	id: string;
	title: string;
	recordedAt: string;
	updatedAt: string;
	transcript: string;
	/**
	 * Optional recording duration in milliseconds.
	 *
	 * Older recordings will not have this populated, so callers must handle it being
	 * absent.
	 */
	duration?: number;
	/**
	 * Recording lifecycle status:
	 * 1. Begins in 'UNPROCESSED' state
	 * 2. Moves to 'TRANSCRIBING' while audio is being transcribed
	 * 3. Marked as 'DONE' when transcription completes
	 * 4. Marked as 'FAILED' if transcription fails
	 */
	transcriptionStatus: 'UNPROCESSED' | 'TRANSCRIBING' | 'DONE' | 'FAILED';
};
