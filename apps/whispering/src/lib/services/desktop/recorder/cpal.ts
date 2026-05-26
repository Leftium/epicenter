import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { remove } from '@tauri-apps/plugin-fs';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { WhisperingRecordingState } from '$lib/constants/audio';
import { FsServiceLive } from '$lib/services/desktop/fs';
import { categorizeRecorderError } from '$lib/services/recorder/categorize-error';
import {
	asDeviceIdentifier,
	type CpalRecordingParams,
	type Device,
	type DeviceAcquisitionOutcome,
	RecorderError,
	type Recording,
	type RecorderService,
} from '$lib/services/recorder/types';

/**
 * Audio recording data returned from the Rust method
 */
type AudioRecording = {
	sampleRate: number;
	channels: number;
	durationSeconds: number;
	filePath?: string;
};

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

		const teardown = () => {
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
				const { data: audioRecording, error: stopRecordingError } =
					await invoke<AudioRecording>('stop_recording');
				if (stopRecordingError) {
					teardown();
					return RecorderError.StopFailed({ cause: stopRecordingError });
				}

				const { filePath } = audioRecording;
				if (!filePath) {
					teardown();
					return RecorderError.NoFilePath();
				}

				sendStatus({
					title: '📁 Reading Recording',
					description: 'Loading your recording from disk...',
				});

				const { data: blob, error: readRecordingFileError } =
					await FsServiceLive.pathToBlob(filePath);
				if (readRecordingFileError) {
					teardown();
					return RecorderError.ReadFileFailed({
						cause: readRecordingFileError,
					});
				}

				sendStatus({
					title: '🔄 Closing Session',
					description: 'Cleaning up recording resources...',
				});
				const { error: closeError } = await invoke<void>(
					'close_recording_session',
				);
				if (closeError) {
					// Log but don't fail the stop operation
					console.error('Failed to close recording session:', closeError);
				}

				teardown();
				return Ok({ blob, recordingId });
			},

			cancel: async ({ sendStatus }) => {
				sendStatus({
					title: '🛑 Cancelling',
					description:
						'Safely stopping your recording and cleaning up resources...',
				});

				// First get the recording data to know if there's a file to delete
				const { data: audioRecording } =
					await invoke<AudioRecording>('stop_recording');

				if (audioRecording?.filePath) {
					const filePath = audioRecording.filePath;
					const { error: removeError } = await tryAsync({
						try: () => remove(filePath),
						catch: (error) => RecorderError.FileDeleteFailed({ cause: error }),
					});
					if (removeError)
						sendStatus({
							title: '❌ Error Deleting Recording File',
							description:
								"We couldn't delete the recording file. Continuing with the cancellation process...",
						});
				}

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

				teardown();
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
