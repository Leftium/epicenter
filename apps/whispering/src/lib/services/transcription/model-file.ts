/**
 * At least 90% of the expected size: detects corrupted or interrupted
 * downloads that would otherwise load successfully and produce garbage
 * transcripts (Whisper) or fail to load at all (Parakeet/Moonshine).
 */
export function isModelFileSizeValid(
	actualBytes: number,
	expectedBytes: number,
): boolean {
	return actualBytes >= expectedBytes * 0.9;
}
