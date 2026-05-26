import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { WhisperingRecordingState } from '$lib/constants/audio';
import { categorizeRecorderError } from '$lib/services/recorder/categorize-error';
import {
	type AudioArtifact,
	asDeviceIdentifier,
	type CpalRecordingParams,
	type Device,
	type DeviceAcquisitionOutcome,
	RecorderError,
	type RecorderService,
	type Recording,
} from '$lib/services/recorder/types';

/**
 * Parse the binary response from `stop_recording`. Wire layout (LE):
 *   bytes 0..4   : u32  rate
 *   bytes 4..6   : u16  channels
 *   bytes 6..8   : u16  reserved
 *   bytes 8..    : f32[] samples
 *
 * The `Float32Array` is a zero-copy view over the IPC body, not a
 * decimal-decoded array of doubles. For a 30 s clip this collapses the
 * post-stop critical path by ~150-300 ms compared to JSON `Vec<f32>`.
 */
function parseArtifact(
	buffer: ArrayBuffer,
): Extract<AudioArtifact, { kind: 'pcm' }> {
	const view = new DataView(buffer);
	const rate = view.getUint32(0, true);
	const channels = view.getUint16(4, true);
	const samples = new Float32Array(buffer, 8);
	return {
		kind: 'pcm',
		samples,
		rate,
		channels,
	};
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
				const { data: buffer, error: stopRecordingError } =
					await invoke<ArrayBuffer>('stop_recording');
				if (stopRecordingError) {
					teardown(recording);
					return RecorderError.StopFailed({ cause: stopRecordingError });
				}

				const artifact = parseArtifact(buffer);
				const durationMs = Math.round(
					(artifact.samples.length / artifact.rate / artifact.channels) * 1000,
				);

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
				// samples and tears down the session worker. One round trip.
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
			{ selectedDeviceId, recordingId, sampleRate }: CpalRecordingParams,
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
