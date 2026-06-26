import {
	type Connection,
	resolveConnection,
	transcribe,
} from '@epicenter/client';
import { InstantString } from '@epicenter/field';
import {
	type AnyTaggedError,
	defineErrors,
	extractErrorMessage,
} from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { customFetch } from '#platform/http';
import { tauri } from '#platform/tauri';
import {
	SUPPORTED_LANGUAGES,
	type SupportedLanguage,
} from '$lib/constants/languages';
import { WHISPER_MODELS } from '$lib/constants/local-models';
import { analytics } from '$lib/operations/analytics';
import { report } from '$lib/report';
import { services } from '$lib/services';
import { DeepgramTranscriptionServiceLive } from '$lib/services/transcription/cloud/deepgram';
import { ElevenLabsTranscriptionServiceLive } from '$lib/services/transcription/cloud/elevenlabs';
import { MistralTranscriptionServiceLive } from '$lib/services/transcription/cloud/mistral';
import {
	isLocalProviderId,
	type LocalProviderId,
	PROVIDERS,
	type TranscriptionServiceId,
} from '$lib/services/transcription/providers';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { recordings } from '$lib/state/recordings.svelte';
import { settings } from '$lib/state/settings.svelte';
import { commands } from '$lib/tauri/commands';

/**
 * The error any transcription path can surface. Deliberately `AnyTaggedError`
 * rather than the concrete provider-error union: every consumer (toast,
 * failed-row tooltip, practice view, analytics) presents these by `.message`,
 * and none discriminate on `.name`. The user-facing message is curated where
 * the context lives, in each service's `defineErrors` constructors, so this
 * boundary only needs to promise `{ name, message }`. Widening to the full
 * union would add error variants no consumer reads.
 */
export type TranscriptionError = AnyTaggedError;

const TranscriptionOperationError = defineErrors({
	NoTranscriptionServiceSelected: () => ({
		message: 'Please select a transcription service in settings.',
	}),
	LocalTranscriptionUnavailableOnWeb: () => ({
		message:
			'Local transcription is only available in the desktop app. Choose a cloud or self-hosted provider on web.',
	}),
	LocalModelNotSelected: ({
		engineDisplayName,
		kind,
	}: {
		engineDisplayName: string;
		kind: 'file' | 'directory';
	}) => ({
		message: `Please select a ${engineDisplayName} model ${kind} in settings.`,
		engineDisplayName,
		kind,
	}),
	CorruptedModelFile: ({
		actualSizeMb,
		expectedSizeMb,
	}: {
		actualSizeMb: number;
		expectedSizeMb: number;
	}) => ({
		message: `The model file is ${actualSizeMb}MB but should be ~${expectedSizeMb}MB. This usually happens when a download was interrupted. Please delete and re-download the model.`,
		actualSizeMb,
		expectedSizeMb,
	}),
});

type BespokeTranscribe = (
	audio: Blob,
	options: {
		prompt: string;
		spokenLanguage: SupportedLanguage;
		apiKey: string;
		modelName: string;
	},
) => Promise<Result<string, TranscriptionError>>;

/** A wire provider's resolved target: the Connection to reach and the model to ask for. */
type WireTarget = { connection: Connection; model: string };

/**
 * The OpenAI-wire transcription providers, collapsed onto the one shared
 * `transcribe()` client (ADR-0050/0060). Each entry assembles a `Connection` (base
 * URL plus optional key) and a model; the wire and the multipart shaping belong to
 * `@epicenter/client`, not here. A wire provider is not a code path; it is a
 * `Connection` value handed to the same function.
 *
 * The config KEYS come from `PROVIDERS` (the SSOT for which device-config/settings
 * entry holds each fact), read through the typed `*ConfigKey` / `*SettingKey`
 * pointers exactly as the old dispatcher did. The only fact `PROVIDERS` does not
 * hold is the canonical wire base URL (it used to be each SDK's default), so that
 * one literal lives here. The endpoint override, when set, already carries `/v1` by
 * the OpenAI base-URL convention; Speaches is the exception, storing a bare host,
 * so its `/v1` is appended.
 */
const WIRE_CONNECTIONS = {
	OpenAI: (): WireTarget => ({
		connection: {
			baseUrl:
				deviceConfig.get(PROVIDERS.OpenAI.endpointConfigKey) ||
				'https://api.openai.com/v1',
			apiKey: deviceConfig.get(PROVIDERS.OpenAI.apiKeyConfigKey) || undefined,
		},
		model: settings.get(PROVIDERS.OpenAI.modelSettingKey),
	}),
	Groq: (): WireTarget => ({
		connection: {
			baseUrl:
				deviceConfig.get(PROVIDERS.Groq.endpointConfigKey) ||
				'https://api.groq.com/openai/v1',
			apiKey: deviceConfig.get(PROVIDERS.Groq.apiKeyConfigKey) || undefined,
		},
		model: settings.get(PROVIDERS.Groq.modelSettingKey),
	}),
	speaches: (): WireTarget => ({
		// The Speaches endpoint config holds a bare host (placeholder
		// `http://localhost:8000`); the Connection base carries `/v1`, which the
		// shared client appends the wire path to. No key: a local box is keyless.
		connection: {
			baseUrl: `${deviceConfig.get(PROVIDERS.speaches.endpointConfigKey)}/v1`,
		},
		model: deviceConfig.get(PROVIDERS.speaches.modelIdConfigKey),
	}),
} satisfies Partial<Record<TranscriptionServiceId, () => WireTarget>>;

type WireProviderId = keyof typeof WIRE_CONNECTIONS;

function isWireProviderId(id: TranscriptionServiceId): id is WireProviderId {
	return id in WIRE_CONNECTIONS;
}

/**
 * The bespoke (non-wire) cloud transcribers, keyed by provider id. These keep
 * their own SDK clients because they do not speak the OpenAI transcription wire:
 * Deepgram takes a raw body under `Authorization: Token`, ElevenLabs an
 * `xi-api-key` with `model_id`, and Mistral's prompt field is `context_bias`, not
 * the OpenAI `prompt`. ADR-0060 blesses this exception.
 *
 * The `satisfies Record<Exclude<TranscriptionServiceId, LocalProviderId |
 * WireProviderId>, ...>` ties the table to PROVIDERS: every non-local provider
 * must be classified as wire (in `WIRE_CONNECTIONS`) or bespoke (here), or it is a
 * compile error. The remainder is all cloud today; a future self-hosted box that
 * does not speak the wire lands here too, so the guard cannot silently drop it.
 */
const BESPOKE_TRANSCRIBERS = {
	ElevenLabs: ElevenLabsTranscriptionServiceLive.transcribe,
	Deepgram: DeepgramTranscriptionServiceLive.transcribe,
	Mistral: MistralTranscriptionServiceLive.transcribe,
} satisfies Record<
	Exclude<TranscriptionServiceId, LocalProviderId | WireProviderId>,
	BespokeTranscribe
>;

function isBespokeProviderId(
	id: TranscriptionServiceId,
): id is Exclude<TranscriptionServiceId, LocalProviderId | WireProviderId> {
	return id in BESPOKE_TRANSCRIBERS;
}

function getSpokenLanguage(): SupportedLanguage {
	const language = settings.get('transcription.language');
	for (const supportedLanguage of SUPPORTED_LANGUAGES) {
		if (supportedLanguage === language) {
			return supportedLanguage;
		}
	}
	return 'auto';
}

/**
 * Materialize the bytes to upload for a cloud transcription. The recording
 * is already saved under `recordings/{id}.{ext}`; in Tauri we round-trip
 * through Rust's libopus to land on a compressed opus blob. On the web
 * there is no Rust, so we fetch the original bytes from the blob store and
 * upload them as-is.
 */
async function loadForCloudUpload(
	recordingId: string,
): Promise<Result<Blob, TranscriptionError>> {
	if (tauri) {
		const { data: oggBytes, error } =
			await commands.encodeRecordingForUpload(recordingId);
		if (error === null) return Ok(new Blob([oggBytes], { type: 'audio/ogg' }));
		report.info({
			title: 'Audio compression skipped',
			description: `${error}. Uploading uncompressed audio instead.`,
		});
		analytics.logEvent({
			type: 'compression_failed',
			provider: settings.get('transcription.service'),
			error_message: error,
		});
	}

	return services.blobs.audio.getBlob(recordingId);
}

/**
 * Transcribe a saved recording by id. This is the single canonical entry
 * point for transcription:
 *
 * - The cpal stop path saves the WAV via Rust and returns the id.
 * - The navigator / VAD / file import paths save the blob via the
 *   recordings blob store and pass the id here.
 *
 * Local transcription always goes through `transcribe_recording(id)`.
 * Cloud and self-hosted transcription upload compressed bytes derived from the
 * saved file when possible, falling back to the raw blob.
 */
export async function transcribeAudio(
	recordingId: string,
): Promise<Result<string, TranscriptionError>> {
	const selectedService = settings.get('transcription.service');

	const startTime = Date.now();
	analytics.logEvent({
		type: 'transcription_requested',
		provider: selectedService,
	});

	const transcriptionResult =
		PROVIDERS[selectedService].location === 'local'
			? await transcribeLocally(recordingId, selectedService)
			: await transcribeViaUpload(recordingId, selectedService);

	const duration = Date.now() - startTime;
	if (transcriptionResult.error) {
		analytics.logEvent({
			type: 'transcription_failed',
			provider: selectedService,
			error_name: transcriptionResult.error.name,
			error_message: transcriptionResult.error.message,
		});
	} else {
		analytics.logEvent({
			type: 'transcription_completed',
			provider: selectedService,
			duration,
		});
	}

	return transcriptionResult;
}

/**
 * Transcribe a saved recording by id and persist the outcome to the recordings
 * table: on success the transcript plus a completed outcome, on failure a
 * failed outcome carrying the error. Every path that transcribes (the record
 * pipeline, manual retry, bulk) goes through here, so the stored outcome can
 * never drift between callers.
 */
export async function transcribeAndPersist(
	recordingId: string,
): Promise<Result<string, TranscriptionError>> {
	const { data: transcribedText, error } = await transcribeAudio(recordingId);
	if (error) {
		recordings.update(recordingId, {
			transcription: {
				status: 'failed',
				completedAt: InstantString.now(),
				error: extractErrorMessage(error),
			},
		});
		return Err(error);
	}
	recordings.update(recordingId, {
		transcript: transcribedText,
		transcription: {
			status: 'completed',
			completedAt: InstantString.now(),
		},
	});
	return Ok(transcribedText);
}

/**
 * Whisper .bin downloads can finish at a smaller-than-expected size when the
 * connection drops mid-stream. The file still loads via whisper.cpp but
 * produces nonsense transcripts. Catalog match is best-effort: only models
 * we recognize from `WHISPER_MODELS` have an expected size to compare, and
 * any filesystem failure passes through (Rust reports load errors itself).
 */
async function checkWhisperTruncation(
	modelName: string,
): Promise<Result<void, TranscriptionError>> {
	const modelConfig = WHISPER_MODELS.find((m) => m.file.filename === modelName);
	if (!modelConfig) return Ok(undefined);

	// Rust resolves the entry through any link, stats it, and applies the 90%
	// completeness rule against the catalog size we pass; an empty filename list
	// means "the entry is itself the file" (Whisper). A missing/unstattable file
	// passes through (Rust reports load errors itself).
	const { data: statuses } = await commands.resolveModelFiles(
		'whispercpp',
		modelName,
		[],
		[modelConfig.sizeBytes],
	);
	const status = statuses?.[0];
	if (!status || status.size == null) return Ok(undefined);

	if (!status.complete) {
		return TranscriptionOperationError.CorruptedModelFile({
			actualSizeMb: Math.round(status.size / 1000000),
			expectedSizeMb: Math.round(modelConfig.sizeBytes / 1000000),
		});
	}
	return Ok(undefined);
}

/**
 * Warm the selected local model the instant a capture begins, so the cold
 * load (~1 s) overlaps the user's speech instead of being paid after they
 * stop. Called fire-and-forget from the manual and VAD start paths.
 *
 * No-op unless we are on desktop with a local provider selected and a model
 * chosen: cloud/self-hosted have no local model to load, and web has no Rust.
 * It resolves the model exactly the way `transcribeLocally` does, so it warms
 * the same model transcription will use. Failures are swallowed on purpose:
 * the worst case is transcription loads the model itself, as it does today.
 * `language`/`initialPrompt` are inference params, irrelevant to loading, so
 * they are sent null.
 */
export function prewarmLocalModel(): void {
	if (!tauri) return;

	const selectedService = settings.get('transcription.service');
	if (!isLocalProviderId(selectedService)) return;

	const provider = PROVIDERS[selectedService];
	const modelName = deviceConfig.get(provider.modelConfigKey);
	if (!modelName) return;

	void commands.prewarmModel({
		engine: selectedService,
		modelName,
		language: null,
		initialPrompt: null,
	});
}

async function transcribeLocally(
	recordingId: string,
	selectedService: TranscriptionServiceId,
): Promise<Result<string, TranscriptionError>> {
	if (!tauri) {
		return TranscriptionOperationError.LocalTranscriptionUnavailableOnWeb();
	}

	if (!isLocalProviderId(selectedService)) {
		return TranscriptionOperationError.NoTranscriptionServiceSelected();
	}
	const provider = PROVIDERS[selectedService];

	// Rust owns model resolution and validation: it joins this model name under
	// its models directory and reports missing or invalid models with
	// user-facing messages. The FE keeps two checks Rust cannot make as well:
	// "nothing selected yet" (instant, no IPC) and the catalog-size truncation
	// check (the expected sizes live in the JS catalog).
	const modelName = deviceConfig.get(provider.modelConfigKey);
	if (!modelName) {
		return TranscriptionOperationError.LocalModelNotSelected({
			engineDisplayName: provider.label,
			kind: provider.modelKind,
		});
	}

	if (selectedService === 'whispercpp') {
		const truncated = await checkWhisperTruncation(modelName);
		if (truncated.error) return truncated;
	}

	// Read-at-use: the per-call spec is built right here, where it is consumed,
	// so there is no ambient config to go stale. `auto` language and an empty
	// prompt map to null (the wire's "unset").
	const language = settings.get('transcription.language');
	const prompt = settings.get('transcription.prompt');
	return commands.transcribeRecording(recordingId, {
		engine: selectedService,
		modelName,
		language: language === 'auto' ? null : language,
		initialPrompt: prompt || null,
	});
}

async function transcribeViaUpload(
	recordingId: string,
	selectedService: TranscriptionServiceId,
): Promise<Result<string, TranscriptionError>> {
	const { data: audio, error: loadError } =
		await loadForCloudUpload(recordingId);
	if (loadError) return Err(loadError);

	const spokenLanguage = getSpokenLanguage();
	const prompt = settings.get('transcription.prompt');

	// The OpenAI-wire providers (OpenAI, Groq, Speaches) collapse onto the one
	// shared client: resolve a Connection, call transcribe(). `auto` language and
	// an empty prompt map to the wire's "unset" (omitted from the form). No more
	// per-provider key-format pre-check: no key just means no header, and the
	// server answers 401, surfaced as a RequestFailed carrying that detail.
	if (isWireProviderId(selectedService)) {
		const { connection, model } = WIRE_CONNECTIONS[selectedService]();
		return transcribe(audio, resolveConnection(connection, customFetch), {
			model,
			language: spokenLanguage === 'auto' ? undefined : spokenLanguage,
			prompt: prompt || undefined,
		});
	}

	// The bespoke cloud providers keep their own SDK clients (different wires).
	// None take an endpoint override (`endpointConfigKey` is null for all three),
	// so there is no baseURL to thread; a custom endpoint is a wire provider.
	if (isBespokeProviderId(selectedService)) {
		const provider = PROVIDERS[selectedService];
		return BESPOKE_TRANSCRIBERS[selectedService](audio, {
			spokenLanguage,
			prompt,
			apiKey: deviceConfig.get(provider.apiKeyConfigKey),
			modelName: settings.get(provider.modelSettingKey),
		});
	}

	return TranscriptionOperationError.NoTranscriptionServiceSelected();
}
