// Raw RMS for speech is small (~0.05 quiet, ~0.2 loud); this gain on a sqrt
// curve maps that range across the meter without clipping early. Mirrors the
// curve the Tauri overlay webview applies to the mic-level event.
const LEVEL_GAIN = 2.4;

/**
 * Reactive mic level for the web pill. On desktop the level travels over a Tauri
 * event to the overlay webview, which smooths it there; on web the pill is an
 * in-page component, so the smoothing lives here and the host reads `level`
 * reactively. Fed by the browser `recording-overlay` seam's `reportLevel`.
 */
function createWebPillLevel() {
	let level = $state(0);

	return {
		/** Live, smoothed mic loudness, 0 (silent) to 1 (loud). */
		get level(): number {
			return level;
		},

		/** Fold a raw RMS sample into the smoothed level. */
		report(raw: number): void {
			const normalized = Math.min(1, Math.sqrt(raw) * LEVEL_GAIN);
			// Exponential smoothing so the bars glide instead of jittering.
			level = level * 0.6 + normalized * 0.4;
		},
	};
}

export const webPillLevel = createWebPillLevel();
