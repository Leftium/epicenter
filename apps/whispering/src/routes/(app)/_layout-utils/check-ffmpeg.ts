import { toast } from '@epicenter/ui/sonner';
import { goto } from '$app/navigation';
import { desktopRpc } from '$lib/query/desktop';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { settings } from '$lib/state/settings.svelte';

export const COMPRESSION_RECOMMENDED_MESSAGE =
	"Since you're using CPAL recording with cloud transcription, we recommend enabling audio compression to reduce file sizes and upload times.";

function isUsingLocalTranscription(): boolean {
	const service = settings.get('transcription.service');
	return (
		service === 'whispercpp' ||
		service === 'parakeet' ||
		service === 'moonshine'
	);
}

/**
 * Compression is RECOMMENDED when using CPAL + cloud transcription AND compression is not enabled
 * @returns true when compression should be recommended to the user
 */
export function isCompressionRecommended(): boolean {
	return (
		deviceConfig.get('recording.method') === 'cpal' &&
		!isUsingLocalTranscription() &&
		!settings.get('transcription.compressionEnabled')
	);
}

/**
 * Checks if audio compression should be recommended for optimal cloud transcription performance.
 * Shows an info toast suggesting compression when using CPAL recording with cloud services.
 *
 * Compression is recommended when:
 * - Using CPAL recording method (which produces uncompressed WAV files)
 * - Using cloud transcription services (not local models)
 * - Compression is not already enabled
 *
 * This helps reduce file sizes and upload times for cloud transcription services.
 *
 * @returns Promise<void> - Shows toast notification if compression is recommended
 */
export async function checkCompressionRecommendation() {
	if (!window.__TAURI_INTERNALS__) return;

	// Check if compression should be recommended
	if (!isCompressionRecommended()) return;

	const { data: ffmpegInstalled } =
		await desktopRpc.ffmpeg.checkFfmpegInstalled.ensure();
	if (ffmpegInstalled) return; // FFmpeg is required for compression

	// FFmpeg is RECOMMENDED for compression
	toast.info('Enable Compression for Faster Uploads', {
		description: COMPRESSION_RECOMMENDED_MESSAGE,
		action: {
			label: 'Go to Transcription Settings',
			onClick: () => goto('/settings/transcription'),
		},
		duration: 10000,
	});
}
