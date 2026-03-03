import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { WhisperingSoundNames } from '$lib/constants/sounds';

export const SoundError = defineErrors({
	Play: ({ message }: { message: string }) => ({ message }),
});
export type SoundError = InferErrors<typeof SoundError>;

export type PlaySoundService = {
	playSound: (
		soundName: WhisperingSoundNames,
	) => Promise<Result<void, SoundError>>;
};
