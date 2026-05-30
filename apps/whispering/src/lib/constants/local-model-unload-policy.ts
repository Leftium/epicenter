/**
 * When to drop the resident local transcription model from memory after the
 * user stops transcribing. Single source of truth: the OPTIONS array below
 * carries values, labels, and descriptions; the tuple and union type are
 * derived from it (same pattern as TRANSCRIPTION -> TRANSCRIPTION_SERVICE_IDS).
 *
 * Mirrored in Rust by the `UnloadPolicy` enum in
 * `src-tauri/src/transcription/config.rs` (serde rename tags pair each value
 * with a variant). If you add a value here, add a matching variant there.
 *
 * Default order is UX order (recommended first), not alphabetical.
 */
export const LOCAL_MODEL_UNLOAD_POLICY_OPTIONS = [
	{
		value: 'after_5_minutes',
		label: 'After 5 minutes',
		description: 'Drop the model after 5 minutes of inactivity. Good default.',
	},
	{
		value: 'after_30_minutes',
		label: 'After 30 minutes',
		description:
			'Drop the model after 30 minutes of inactivity. Useful for bursty workflows.',
	},
	{
		value: 'immediately',
		label: 'Immediately',
		description:
			'Drop after every transcription. Minimum memory, slowest next transcription.',
	},
	{
		value: 'never',
		label: 'Never',
		description: 'Keep the model resident until the app exits.',
	},
] as const;

export type LocalModelUnloadPolicy =
	(typeof LOCAL_MODEL_UNLOAD_POLICY_OPTIONS)[number]['value'];

/** Convenience array for `type.enumerated(...LOCAL_MODEL_UNLOAD_POLICIES)`. */
export const LOCAL_MODEL_UNLOAD_POLICIES = LOCAL_MODEL_UNLOAD_POLICY_OPTIONS.map(
	(o) => o.value,
) as LocalModelUnloadPolicy[];
