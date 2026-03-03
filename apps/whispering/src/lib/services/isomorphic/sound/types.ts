import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { WhisperingSoundNames } from '$lib/constants/sounds';

export const SoundError = defineErrors({
	Play: ({ cause }: { cause: unknown }) => ({
		message: `Failed to play sound: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type SoundError = InferErrors<typeof SoundError>;

export type PlaySoundService = {
	playSound: (
		soundName: WhisperingSoundNames,
	) => Promise<Result<void, SoundError>>;
};
