// Direct imports and re-exports from organized services

// Cloud transcription services
import { DeepgramTranscriptionServiceLive } from './cloud/deepgram';
import { ElevenLabsTranscriptionServiceLive } from './cloud/elevenlabs';
import { GroqTranscriptionServiceLive } from './cloud/groq';
import { MistralTranscriptionServiceLive } from './cloud/mistral';
import { OpenaiTranscriptionServiceLive } from './cloud/openai';
// Local transcription services
import { MoonshineTranscriptionService } from './local/moonshine';
import { ParakeetTranscriptionService } from './local/parakeet';
import { WhisperCppTranscriptionService } from './local/whispercpp';

// Self-hosted transcription services
import { SpeachesTranscriptionServiceLive } from './self-hosted/speaches';

export {
	DeepgramTranscriptionServiceLive as deepgram,
	ElevenLabsTranscriptionServiceLive as elevenlabs,
	GroqTranscriptionServiceLive as groq,
	MistralTranscriptionServiceLive as mistral,
	MoonshineTranscriptionService as moonshine,
	OpenaiTranscriptionServiceLive as openai,
	ParakeetTranscriptionService as parakeet,
	SpeachesTranscriptionServiceLive as speaches,
	WhisperCppTranscriptionService as whispercpp,
};
