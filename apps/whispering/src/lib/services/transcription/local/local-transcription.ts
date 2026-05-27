import { stat } from '@tauri-apps/plugin-fs';
import { Ok, tryAsync } from 'wellcrafted/result';
import { WhisperingErr, type WhisperingResult } from '$lib/result';
import {
	commands,
	type TranscribeRequest,
	type TranscriptionError,
} from '$lib/tauri/commands';

/**
 * The Rust `TranscribeRequest` enum (`#[serde(tag = "engine", rename_all =
 * "lowercase")]`) is the single source of truth for this argument shape;
 * the boundary file re-exports the generated TS union. We keep the local
 * alias `TranscribeConfig` so engine adapters that already import it stay
 * unchanged.
 *
 * The `engine` tag values match `transcription.service` in user settings.
 * The Rust enum variant is named `Whisper` but serializes as `whispercpp`
 * (see `#[serde(rename)]` on the Rust side).
 */
export type TranscribeConfig = TranscribeRequest;

/**
 * Validate that `modelPath` exists and is the expected `kind`. All three
 * local services share this exact preflight (only Whisper layers a
 * file-size check on top), so it lives here. Uses a single `stat()` call
 * for both existence and kind, replacing the previous `exists()` +
 * `stat()` two-step.
 */
export async function requireExistingModelPath(
	modelPath: string,
	kind: 'file' | 'directory',
	engineDisplayName: string,
): Promise<WhisperingResult<void>> {
	const fileOrDir = kind === 'directory' ? 'Directory' : 'File';

	if (!modelPath) {
		return WhisperingErr({
			title: `📁 Model ${fileOrDir} Required`,
			description: `Please select a ${engineDisplayName} model ${kind} in settings.`,
			action: {
				type: 'link',
				label: 'Configure model',
				href: '/settings/transcription',
			},
		});
	}

	const { data: stats } = await tryAsync({
		try: () => stat(modelPath),
		catch: () => Ok(null),
	});

	if (!stats) {
		return WhisperingErr({
			title: `❌ Model ${fileOrDir} Not Found`,
			description: `The model ${kind} "${modelPath}" does not exist.`,
			action: {
				type: 'link',
				label: 'Select model',
				href: '/settings/transcription',
			},
		});
	}

	const isCorrectKind = kind === 'directory' ? stats.isDirectory : stats.isFile;
	if (!isCorrectKind) {
		return WhisperingErr({
			title: '❌ Invalid Model Path',
			description:
				kind === 'directory'
					? `${engineDisplayName} models must be directories containing model files.`
					: `${engineDisplayName} models must be a single file.`,
			action: {
				type: 'link',
				label: `Select model ${kind}`,
				href: '/settings/transcription',
			},
		});
	}

	return Ok(undefined);
}

/**
 * Shared error mapping for the unified `transcribe_recording` command. Each
 * per-engine service used to duplicate this switch with minor copy
 * variations; the only per-engine variation is the display name, which
 * we derive from the config tag.
 */
function mapLocalTranscriptionError(
	error: TranscriptionError,
): WhisperingResult<never> {
	switch (error.name) {
		case 'ModelLoadError':
			return WhisperingErr({
				title: '🤖 Model Loading Error',
				description: error.message,
				action: {
					type: 'more-details',
					error: new Error(error.message),
				},
			});

		case 'GpuError':
			return WhisperingErr({
				title: '🎮 GPU Error',
				description: error.message,
				action: {
					type: 'link',
					label: 'Configure settings',
					href: '/settings/transcription',
				},
			});

		case 'AudioReadError':
			return WhisperingErr({
				title: '🔊 Audio Read Error',
				description: error.message,
				action: {
					type: 'more-details',
					error: new Error(error.message),
				},
			});

		case 'TranscriptionError':
			return WhisperingErr({
				title: '❌ Transcription Error',
				description: error.message,
				action: {
					type: 'more-details',
					error: new Error(error.message),
				},
			});
	}
}

/**
 * Canonical transcribe-by-id path. Rust resolves the recording file under
 * `<appDataDir>/recordings/{recordingId}.*`, decodes it (Symphonia handles
 * WAV, webm/opus, mp4/AAC, etc.), and runs inference. This is the entry
 * point for every local-transcription call: the cpal stop path, the
 * navigator/VAD blob path (after the pipeline saves the blob to disk),
 * file uploads, retry, history replay.
 */
export async function transcribeRecording(
	recordingId: string,
	config: TranscribeConfig,
): Promise<WhisperingResult<string>> {
	const { data, error } = await commands.transcribeRecording(
		recordingId,
		config,
	);
	if (error !== null) return mapLocalTranscriptionError(error);
	return Ok(data);
}
