/**
 * UI-facing provider data: the icons plus the `TRANSCRIPTION_PROVIDERS` join.
 * Kept out of `providers.ts` so the workspace schema can import
 * `TRANSCRIPTION_SERVICE_IDS` without bundling these `?raw` SVGs.
 * `TRANSCRIPTION_PROVIDERS` is the join of each provider's data with its icon:
 * an array (id + every provider field + icon) that the settings selectors
 * iterate and filter by `location`.
 */
import deepgramIcon from '$lib/constants/icons/deepgram.svg?raw';
import elevenlabsIcon from '$lib/constants/icons/elevenlabs.svg?raw';
import ggmlIcon from '$lib/constants/icons/ggml.svg?raw';
import groqIcon from '$lib/constants/icons/groq.svg?raw';
import mistralIcon from '$lib/constants/icons/mistral.svg?raw';
import moonshineIcon from '$lib/constants/icons/moonshine.svg?raw';
import nvidiaIcon from '$lib/constants/icons/nvidia.svg?raw';
import openaiIcon from '$lib/constants/icons/openai.svg?raw';
import speachesIcon from '$lib/constants/icons/speaches.svg?raw';
import { PROVIDERS, type TranscriptionServiceId } from './providers';

export const PROVIDER_ICONS = {
	OpenAI: { icon: openaiIcon, invertInDarkMode: true },
	Groq: { icon: groqIcon, invertInDarkMode: false },
	ElevenLabs: { icon: elevenlabsIcon, invertInDarkMode: true },
	Deepgram: { icon: deepgramIcon, invertInDarkMode: true },
	Mistral: { icon: mistralIcon, invertInDarkMode: false },
	whispercpp: { icon: ggmlIcon, invertInDarkMode: true },
	parakeet: { icon: nvidiaIcon, invertInDarkMode: false },
	moonshine: { icon: moonshineIcon, invertInDarkMode: false },
	speaches: { icon: speachesIcon, invertInDarkMode: false },
} as const satisfies Record<
	TranscriptionServiceId,
	{ icon: string; invertInDarkMode: boolean }
>;

/** UI-facing list: each provider's data joined with its icon, in declaration order. */
export const TRANSCRIPTION_PROVIDERS = (
	Object.entries(PROVIDERS) as [
		TranscriptionServiceId,
		(typeof PROVIDERS)[TranscriptionServiceId],
	][]
).map(([id, provider]) => ({ id, ...provider, ...PROVIDER_ICONS[id] }));

export type TranscriptionProviderEntry =
	(typeof TRANSCRIPTION_PROVIDERS)[number];
