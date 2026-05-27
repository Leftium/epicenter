import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { WhisperingRecordingState } from '$lib/constants/audio';
import { categorizeRecorderError } from '$lib/services/recorder/categorize-error';
import {
	asDeviceIdentifier,
	type CpalRecordingParams,
	type Device,
	type DeviceAcquisitionOutcome,
	RecorderError,
	type RecorderService,
	type RecordingArtifact,
	type RecordingSession,
} from '$lib/services/recorder/types';

const log = createLogger('whispering/recorder/cpal');

/**
 * Sanity-check the artifact handle Rust returned. Rust validates ids
 * before they touch the filesystem, but we still defend in depth so a
 * malformed IPC payload (e.g. from a future protocol mismatch) surfaces
 * as a clear error rather than wedging a downstream consumer.
 */
function validateArtifact(
	artifact: RecordingArtifact,
	expectedRecordingId: string,
): Result<RecordingArtifact, RecorderError> {
	if (artifact.id !== expectedRecordingId) {
		return RecorderError.InvalidArtifact({
			reason: `id mismatch: expected '${expectedRecordingId}', got '${artifact.id}'`,
			recordingId: expectedRecordingId,
		});
	}
	if (!Number.isFinite(artifact.durationMs) || artifact.durationMs < 0) {
		return RecorderError.InvalidArtifact({
			reason: `durationMs is not a finite non-negative number`,
			recordingId: artifact.id,
		});
	}
	if (!Number.isFinite(artifact.byteLength) || artifact.byteLength < 0) {
		return RecorderError.InvalidArtifact({
			reason: `byteLength is not a finite non-negative number`,
			recordingId: artifact.id,
		});
	}
	return Ok(artifact);
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
 * subscribe) lives on the returned `RecordingSession`. The service itself
 * only holds a pointer to the active session for rehydration through
 * `getActiveRecording`; once stop/cancel runs, that pointer clears.
 *
 * Unlike navigator, a cpal session can outlive a JS reload because the
 * Rust process keeps the cpal stream alive. `getActiveRecording` consults
 * Rust via `get_current_recording_id` and reattaches a new
 * `RecordingSession` wrapper if Rust still has one going.
 *
 * Stop returns a `RecordingArtifact` handle: Rust writes the durable WAV
 * to `<appDataDir>/recordings/{id}.wav` and the JS side refers to the
 * recording by id from then on. There is no raw PCM on the wire.
 */
function createCpalRecorder(): RecorderService {
	let activeSession: RecordingSession | null = null;

	function buildSession(recordingId: string): RecordingSession {
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
			// Rust emits 'recorder:state-changed' from every mutation path
			// (see src-tauri/src/recorder/commands.rs). Forward to subscribers
			// so Rust-initiated transitions (future auto-stop, device
			// disconnect) reach the UI.
			tauriUnlisten = listen<WhisperingRecordingState>(
				'recorder:state-changed',
				(event) => notify(event.payload),
			);
		};

		// Takes `session` as an argument rather than closing over the const
		// declared below. Both work because teardown only runs from
		// stop/cancel handlers (which can only fire after `session` is
		// bound), but the explicit argument keeps the function TDZ-safe if a
		// future caller invokes teardown from a path declared above the
		// `session = ...` initializer.
		const teardown = (session: RecordingSession) => {
			if (activeSession === session) activeSession = null;
			if (tauriUnlisten) {
				void tauriUnlisten.then((unlisten) => unlisten());
				tauriUnlisten = null;
			}
			notify('IDLE');
		};

		// Close the Rust-side session and tear down JS state. Used by the
		// stop happy path and the artifact-validation failure path so a
		// malformed IPC payload can't leave a zombie session in Rust or a
		// stale `activeSession` pointer in JS. Takes `session` explicitly
		// for the same TDZ reason `teardown` does.
		const closeAndTeardown = async (
			session: RecordingSession,
			sendStatus: (args: { title: string; description: string }) => void,
		) => {
			sendStatus({
				title: '🔄 Closing Session',
				description: 'Cleaning up recording resources...',
			});
			const { error: closeError } = await invoke<void>(
				'close_recording_session',
			);
			if (closeError) {
				log.error(closeError);
			}
			teardown(session);
		};

		const session: RecordingSession = {
			recordingId,
			backend: 'cpal',

			stop: async ({ sendStatus }) => {
				sendStatus({
					title: '⏸️ Saving recording',
					description: 'Writing the WAV artifact to disk...',
				});
				const { data: artifact, error: stopRecordingError } =
					await invoke<RecordingArtifact>('stop_recording');
				if (stopRecordingError) {
					teardown(session);
					return RecorderError.StopFailed({ cause: stopRecordingError });
				}

				const { data: validated, error: validateError } = validateArtifact(
					artifact,
					recordingId,
				);
				if (validateError) {
					log.error(validateError);
					await closeAndTeardown(session, sendStatus);
					return Err(validateError);
				}

				await closeAndTeardown(session, sendStatus);
				return Ok({ kind: 'artifact', artifact: validated });
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

				teardown(session);
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

		return session;
	}

	return {
		getActiveRecording: async (): Promise<
			Result<RecordingSession | null, RecorderError>
		> => {
			// If we still hold the in-memory pointer, prefer it; otherwise
			// probe Rust in case a recording session outlived a JS reload.
			if (activeSession) return Ok(activeSession);

			const { data: liveRecordingId, error: getIdError } = await invoke<
				string | null
			>('get_current_recording_id');
			if (getIdError) {
				return RecorderError.GetStateFailed({ cause: getIdError });
			}
			if (!liveRecordingId) return Ok(null);

			const rehydrated = buildSession(liveRecordingId);
			activeSession = rehydrated;
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

			const session = buildSession(recordingId);
			activeSession = session;
			return Ok({ session, deviceAcquisition: deviceOutcome });
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
