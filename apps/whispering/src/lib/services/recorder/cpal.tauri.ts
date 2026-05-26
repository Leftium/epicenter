import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { WhisperingRecordingState } from '$lib/constants/audio';
import { categorizeRecorderError } from '$lib/services/recorder/categorize-error';
import {
	asDeviceIdentifier,
	type AudioArtifact,
	type CpalRecordingParams,
	type Device,
	type DeviceAcquisitionOutcome,
	RecorderError,
	type RecorderService,
	type Recording,
} from '$lib/services/recorder/types';

/**
 * Raw artifact shape coming back from the Rust IPC boundary. The PCM
 * variant arrives with `samples: number[]` because serde's default JSON
 * representation for `Vec<f32>` is an array of numbers; we convert to
 * `Float32Array` here so the in-app type is always the typed array.
 *
 * For longer recordings the JSON-array form of PCM samples is the
 * load-bearing IPC cost; for dictation clips (~30s at 16 kHz = 480k
 * samples) the cost is bounded. If profiling shows it dominates, switch
 * `stop_recording` to a raw IPC response with a binary body.
 */
type RawAudioArtifact =
	| {
			kind: 'pcm';
			samples: number[];
			rate: number;
			channels: number;
			durationSeconds: number;
	  }
	| {
			kind: 'file';
			path: string;
			rate: number;
			channels: number;
			durationSeconds: number;
			container: 'wav';
	  };

function hydrateArtifact(raw: RawAudioArtifact): AudioArtifact {
	if (raw.kind === 'pcm') {
		return {
			kind: 'pcm',
			samples: Float32Array.from(raw.samples),
			rate: raw.rate,
			channels: raw.channels,
			durationSeconds: raw.durationSeconds,
		};
	}
	return raw;
}

/**
 * Enumerates available recording devices from the system.
 */
const enumerateDevices = async (): Promise<Result<Device[], RecorderError>> => {
	const { data: deviceNames, error: enumerateRecordingDevicesError } =
		await invoke<string[]>('enumerate_recording_devices');
	if (enumerateRecordingDevicesError) {
		return RecorderError.EnumerateDevices({
			cause: enumerateRecordingDevicesError,
		});
	}
	// On desktop, device names serve as both ID and label
	return Ok(
		deviceNames.map((name) => ({
			id: asDeviceIdentifier(name),
			label: name,
		})),
	);
};

/**
 * CPAL recorder service that uses the Rust CPAL backend.
 *
 * Constructed via a factory so the per-session lifecycle (stop/cancel/
 * subscribe) lives on the returned `Recording`. The service itself only
 * holds a pointer to the active session for rehydration through
 * `getActiveRecording`; once stop/cancel runs, that pointer clears.
 *
 * Unlike navigator, a cpal session can outlive a JS reload because the
 * Rust process keeps the cpal stream alive. `getActiveRecording` consults
 * Rust via `get_current_recording_id` and reattaches a new `Recording`
 * wrapper if Rust still has one going.
 */
function createCpalRecorder(): RecorderService {
	let activeRecording: Recording | null = null;

	function buildRecording(recordingId: string): Recording {
		const subscribers = new Set<(s: WhisperingRecordingState) => void>();
		let currentState: WhisperingRecordingState = 'RECORDING';
		let tauriUnlisten: Promise<UnlistenFn> | null = null;

		const notify = (state: WhisperingRecordingState) => {
			// Idempotent: same-state notifications collapse to a no-op. Rust
			// emits 'recorder:state-changed' IDLE from `stop_recording`, then
			// our explicit `teardown()` also notifies IDLE; without this
			// guard we'd fire the handler twice for one transition.
			if (currentState === state) return;
			currentState = state;
			for (const handler of subscribers) handler(state);
		};

		const ensureTauriListener = () => {
			if (tauriUnlisten) return;
			// Rust emits 'recorder:state-changed' from every mutation path (see
			// src-tauri/src/recorder/commands.rs). Forward to subscribers so
			// Rust-initiated transitions (future auto-stop, device disconnect)
			// reach the UI.
			tauriUnlisten = listen<WhisperingRecordingState>(
				'recorder:state-changed',
				(event) => notify(event.payload),
			);
		};

		// Takes `recording` as an argument rather than closing over the const
		// declared below. Both work because teardown only runs from stop/cancel
		// handlers (which can only fire after `recording` is bound), but the
		// explicit argument keeps the function TDZ-safe if a future caller
		// invokes teardown from a path declared above the `recording = ...`
		// initializer.
		const teardown = (recording: Recording) => {
			if (activeRecording === recording) activeRecording = null;
			if (tauriUnlisten) {
				void tauriUnlisten.then((unlisten) => unlisten());
				tauriUnlisten = null;
			}
			notify('IDLE');
		};

		const recording: Recording = {
			recordingId,
			backend: 'cpal',

			stop: async ({ sendStatus }) => {
				const { data: raw, error: stopRecordingError } =
					await invoke<RawAudioArtifact>('stop_recording');
				if (stopRecordingError) {
					teardown(recording);
					return RecorderError.StopFailed({ cause: stopRecordingError });
				}

				const artifact = hydrateArtifact(raw);
				const durationMs = Math.round(raw.durationSeconds * 1000);

				sendStatus({
					title: '🔄 Closing Session',
					description: 'Cleaning up recording resources...',
				});
				const { error: closeError } = await invoke<void>(
					'close_recording_session',
				);
				if (closeError) {
					console.error('Failed to close recording session:', closeError);
				}

				teardown(recording);
				return Ok({ artifact, recordingId, durationMs });
			},

			cancel: async ({ sendStatus }) => {
				sendStatus({
					title: '🛑 Cancelling',
					description:
						'Safely stopping your recording and cleaning up resources...',
				});

				// cancel_recording on the Rust side discards the in-flight
				// artifact, deletes the on-disk WAV (file sinks), and tears
				// down the session worker. One round trip.
				const { error: cancelError } = await invoke<void>('cancel_recording');
				if (cancelError) {
					sendStatus({
						title: '❌ Cancel Failed',
						description:
							'We hit a problem cancelling; continuing cleanup anyway...',
					});
				}

				teardown(recording);
				return Ok({ status: 'cancelled' });
			},

			subscribe(handler) {
				ensureTauriListener();
				subscribers.add(handler);
				// Fire current state immediately so callers don't have to mirror
				// 'RECORDING' at attach time.
				handler(currentState);
				return () => {
					subscribers.delete(handler);
				};
			},
		};

		return recording;
	}

	return {
		getActiveRecording: async (): Promise<
			Result<Recording | null, RecorderError>
		> => {
			// If we still hold the in-memory pointer, prefer it; otherwise probe
			// Rust in case a recording outlived a JS reload.
			if (activeRecording) return Ok(activeRecording);

			const { data: liveRecordingId, error: getIdError } = await invoke<
				string | null
			>('get_current_recording_id');
			if (getIdError) {
				return RecorderError.GetStateFailed({ cause: getIdError });
			}
			if (!liveRecordingId) return Ok(null);

			const rehydrated = buildRecording(liveRecordingId);
			activeRecording = rehydrated;
			return Ok(rehydrated);
		},

		enumerateDevices,

		startRecording: async (
			{
				selectedDeviceId,
				recordingId,
				outputFolder,
				sampleRate,
				mode,
			}: CpalRecordingParams,
			{ sendStatus },
		) => {
			const { data: devices, error: enumerateError } = await enumerateDevices();
			if (enumerateError) return Err(enumerateError);

			const deviceIds = devices.map((d) => d.id);
			const fallbackDeviceId = deviceIds.at(0);
			if (!fallbackDeviceId) {
				return RecorderError.NoDevice({
					message: selectedDeviceId
						? "We couldn't find the selected microphone. Make sure it's connected and try again!"
						: "We couldn't find any microphones. Make sure they're connected and try again!",
				});
			}

			const deviceOutcome: DeviceAcquisitionOutcome = (() => {
				if (!selectedDeviceId) {
					sendStatus({
						title: '🔍 No Device Selected',
						description:
							"No worries! We'll find the best microphone for you automatically...",
					});
					return {
						outcome: 'fallback',
						reason: 'no-device-selected',
						deviceId: fallbackDeviceId,
					};
				}

				if (deviceIds.includes(selectedDeviceId)) {
					return { outcome: 'success', deviceId: selectedDeviceId };
				}

				sendStatus({
					title: '⚠️ Finding a New Microphone',
					description:
						"That microphone isn't available. Let's try finding another one...",
				});
				return {
					outcome: 'fallback',
					reason: 'preferred-device-unavailable',
					deviceId: fallbackDeviceId,
				};
			})();

			const deviceIdentifier = deviceOutcome.deviceId;

			sendStatus({
				title: '🎤 Setting Up',
				description:
					'Initializing your recording session and checking microphone access...',
			});

			const sampleRateNum = sampleRate
				? Number.parseInt(sampleRate, 10)
				: undefined;

			const { error: initRecordingSessionError } = await invoke(
				'init_recording_session',
				{
					deviceIdentifier,
					recordingId,
					outputFolder,
					sampleRate: sampleRateNum,
					mode,
				},
			);
			if (initRecordingSessionError)
				return (
					categorizeRecorderError(initRecordingSessionError) ??
					RecorderError.InitFailed({
						cause: initRecordingSessionError,
					})
				);

			sendStatus({
				title: '🎙️ Starting Recording',
				description:
					'Recording session initialized, now starting to capture audio...',
			});
			const { error: startRecordingError } =
				await invoke<void>('start_recording');
			if (startRecordingError)
				return (
					categorizeRecorderError(startRecordingError) ??
					RecorderError.StartFailed({ cause: startRecordingError })
				);

			const recording = buildRecording(recordingId);
			activeRecording = recording;
			return Ok({ recording, deviceAcquisition: deviceOutcome });
		},
	};
}

export const CpalRecorderServiceLive: RecorderService = createCpalRecorder();

/**
 * Wrapper function for Tauri invoke calls that handles errors consistently.
 * Converts Tauri invoke calls into Result types for better error handling.
 *
 * @param command - The Tauri command to invoke
 * @param args - Optional arguments to pass to the command
 */
async function invoke<T>(command: string, args?: Record<string, unknown>) {
	return tryAsync({
		try: async () => await tauriInvoke<T>(command, args),
		catch: (error) => RecorderError.InvokeFailed({ command, cause: error }),
	});
}
