// Direct imports and re-exports from organized services.
//
// Local-engine dispatch is inlined in `$lib/operations/transcribe.ts` (one
// switch over `selectedService`) and routes through Rust's typed
// `transcribe_recording` command. The download catalogs live in
// `$lib/constants/local-models.ts`.

// Cloud transcription services
import { DeepgramTranscriptionServiceLive } from './cloud/deepgram';
import { ElevenLabsTranscriptionServiceLive } from './cloud/elevenlabs';
import { GroqTranscriptionServiceLive } from './cloud/groq';
import { MistralTranscriptionServiceLive } from './cloud/mistral';
import { OpenaiTranscriptionServiceLive } from './cloud/openai';
// Self-hosted transcription services
import { SpeachesTranscriptionServiceLive } from './self-hosted/speaches';

export {
	DeepgramTranscriptionServiceLive as deepgram,
	ElevenLabsTranscriptionServiceLive as elevenlabs,
	GroqTranscriptionServiceLive as groq,
	MistralTranscriptionServiceLive as mistral,
	OpenaiTranscriptionServiceLive as openai,
	SpeachesTranscriptionServiceLive as speaches,
};
