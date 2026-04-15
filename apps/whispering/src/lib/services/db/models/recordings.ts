/**
 * Recording intermediate representation.
 *
 * This is the DB service's normalized recording shape. Storage adapters read their
 * native format and convert into this type before the rest of the app touches it.
 *
 * - Desktop stores recording metadata in markdown frontmatter, with the markdown body
 *   holding the transcript and a sibling audio file holding the blob.
 * - Web stores recording metadata in IndexedDB, alongside serialized audio data.
 *
 * Audio bytes are intentionally excluded from this type. Use the recording DB service
 * methods to fetch or create playback URLs on demand instead of passing blobs around
 * in the intermediate representation.
 */
export type Recording = {
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
