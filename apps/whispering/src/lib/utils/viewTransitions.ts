import type { RecordingTrigger } from '$lib/constants/audio';

/**
 * Centralized view transition names for consistent cross-page animations.
 *
 * View transitions connect UI elements across pages. When two elements on different
 * pages share the same `view-transition-name`, the browser animates between them
 * during navigation.
 *
 * @example
 * ```svelte
 * <!-- Home page -->
 * <audio style="view-transition-name: {viewTransition.recording(id).audio}" />
 *
 * <!-- Recordings page -->
 * <audio style="view-transition-name: {viewTransition.recording(id).audio}" />
 * ```
 *
 * When navigating between pages, the audio element morphs smoothly.
 */
export const viewTransition = {
	/**
	 * Transition names for a specific recording's UI elements.
	 *
	 * @example
	 * ```svelte
	 * <audio style="view-transition-name: {viewTransition.recording(id).audio}" />
	 * <div style="view-transition-name: {viewTransition.recording(id).transcript}" />
	 * ```
	 */
	recording(id: string) {
		return {
			/** The audio player element */
			audio: `recording-${id}-audio`,
			/** The transcript text display */
			transcript: `recording-${id}-transcript`,
			/** The transformation output display */
			transformationOutput: `recording-${id}-transformation-output`,
		} as const;
	},

	/**
	 * Transition name for a transformation card/selector.
	 *
	 * @example
	 * ```svelte
	 * <div style="view-transition-name: {viewTransition.transformation(id)}" />
	 * ```
	 */
	transformation(id: string | null) {
		return `transformation-${id ?? 'none'}` as const;
	},

	/**
	 * The selected recording trigger's mode glyph: the mic for `manual`, the ear
	 * for `vad`. The same glyph appears as a tab on the home page and as the
	 * topbar record button at rest, so sharing the name lets it slide across the
	 * home-to-config navigation.
	 *
	 * Bind it to the glyph only at rest. Once a recording is live the topbar
	 * swaps to a stop control, which is a different object and must not inherit
	 * this name. Both home tabs render at once, but `manual` and `vad` are
	 * distinct names, so they never collide; the topbar carries only the
	 * selected one.
	 *
	 * @example
	 * ```svelte
	 * <MicIcon style="view-transition-name: {viewTransition.recordingMode('manual')}" />
	 * ```
	 */
	recordingMode(trigger: RecordingTrigger) {
		return `recording-mode-${trigger}` as const;
	},

	/**
	 * The capture pipeline's per-stage glyphs. Each stage's control is
	 * re-expressed in the home pipeline and the config topbar, so its glyph
	 * morphs between the two on navigation. The transformation stage uses
	 * `transformation(id)` above; these cover the other two stages.
	 *
	 * Each name renders at most once per document because the home pipeline and
	 * the topbar never appear on the same page.
	 */
	pipeline: {
		/** The microphone device-selector glyph. */
		device: 'pipeline-device',
		/** The transcription service brand glyph. */
		transcription: 'pipeline-transcription',
	},
} as const;

/**
 * Express an optional transition name as an inline `style` value: the
 * `view-transition-name` declaration when a name is supplied, or `undefined` so
 * the attribute is omitted entirely.
 *
 * This is the one place that knows how a name becomes a style, so the reusable
 * controls that thread an optional name down (the action card, the device and
 * transcription selectors) never re-spell the ternary. Owners that always carry
 * a name bind `view-transition-name` in their own `style` string directly.
 */
export function viewTransitionStyle(name: string | undefined) {
	return name ? `view-transition-name: ${name}` : undefined;
}
