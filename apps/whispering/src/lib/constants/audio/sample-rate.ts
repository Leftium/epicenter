/**
 * Audio sample rate constants and options
 */

const SAMPLE_RATES = ['16000', '44100', '48000'] as const;

type SampleRate = (typeof SAMPLE_RATES)[number];

/**
 * Sample rate metadata for generating options with descriptions
 */
const SAMPLE_RATE_METADATA = {
	'16000': { shortLabel: '16 kHz', description: 'Optimized for speech' },
	'44100': { shortLabel: '44.1 kHz', description: 'CD quality' },
	'48000': { shortLabel: '48 kHz', description: 'Studio quality' },
} as const satisfies Record<
	SampleRate,
	{ shortLabel: string; description: string }
>;

/**
 * Sample rate options with descriptive labels
 * Format: "16 kHz - Optimized for speech"
 */
export const SAMPLE_RATE_OPTIONS = SAMPLE_RATES.map((rate) => ({
	value: rate,
	label: `${SAMPLE_RATE_METADATA[rate].shortLabel} - ${SAMPLE_RATE_METADATA[rate].description}`,
}));

/**
 * The sample rate at which the cpal recorder emits captured PCM. The Rust
 * recorder resamples every device to this rate before handing samples to
 * the consumer worker. The user-facing `SAMPLE_RATES` setting above is a
 * hint that picks which cpal device config to open; it does not change the
 * recorder's output rate.
 *
 * Mirrored in:
 *   src-tauri/src/recorder/recorder.rs (`TARGET_RATE`)
 *   src-tauri/src/audio/command.rs (`RECORDER_OUTPUT_RATE`)
 */
export const RECORDER_OUTPUT_RATE = 16_000;
