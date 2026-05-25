import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { nanoid } from 'nanoid/non-secure';
import { Ok } from 'wellcrafted/result';
import type { WhisperingRecordingState } from '$lib/constants/audio';
import { PATHS } from '$lib/constants/paths';
import { defineQuery } from '$lib/query/client';
import { notify } from '$lib/query/notify';
import { WhisperingErr } from '$lib/result';
import { services } from '$lib/services';
import { desktopServices } from '$lib/services/desktop';
import {
	asDeviceIdentifier,
	type StartRecordingParams,
} from '$lib/services/recorder/types';
import { deviceConfig } from '$lib/state/device-config.svelte';

/**
 * Creates the manual recorder with reactive state.
 *
 * State is owned by this module via Svelte's $state rune for synchronous
 * reactivity. Mirrors the shape of `vadRecorder` in `vad-recorder.svelte.ts`:
 *
 * - Reactive access: `manualRecorder.state` (triggers effects on change)
 * - Operations: `manualRecorder.startRecording({ toastId })` etc.
 * - Device enumeration as a TanStack Query for loading states in selectors
 *
 * On Tauri, state is bootstrapped from the active service's `getRecorderState`
 * once at module init (a Rust CPAL session can outlive a JS reload). A Tauri
 * `recorder:state-changed` listener is registered to receive future Rust-side
 * transitions. The Rust emit side is not yet wired; the listener is a no-op
 * until that lands and harmless in the meantime.
 */
function recorderService() {
	if (!isTauri()) return services.navigatorRecorder;
	return deviceConfig.get('recording.method') === 'cpal'
		? desktopServices.cpalRecorder
		: services.navigatorRecorder;
}

async function buildStartParams(
	recordingId: string,
): Promise<StartRecordingParams> {
	const useCpal =
		isTauri() && deviceConfig.get('recording.method') === 'cpal';

	if (useCpal) {
		const deviceId = deviceConfig.get('recording.cpal.deviceId');
		return {
			method: 'cpal',
			recordingId,
			selectedDeviceId: deviceId ? asDeviceIdentifier(deviceId) : null,
			outputFolder:
				deviceConfig.get('recording.cpal.outputFolder') ??
				(await PATHS.DB.RECORDINGS()),
			sampleRate: deviceConfig.get('recording.cpal.sampleRate'),
		};
	}

	const deviceId = deviceConfig.get('recording.navigator.deviceId');
	return {
		method: 'navigator',
		recordingId,
		selectedDeviceId: deviceId ? asDeviceIdentifier(deviceId) : null,
		bitrateKbps: deviceConfig.get('recording.navigator.bitrateKbps'),
	};
}

function createManualRecorder() {
	let _state = $state<WhisperingRecordingState>('IDLE');
	let _currentRecordingId: string | null = null;

	void recorderService()
		.getRecorderState()
		.then(({ data }) => {
			if (data) _state = data;
		});

	if (isTauri()) {
		void listen<WhisperingRecordingState>('recorder:state-changed', (event) => {
			_state = event.payload;
		});
	}

	return {
		get state(): WhisperingRecordingState {
			return _state;
		},

		enumerateDevices: defineQuery({
			queryKey: ['recorder', 'devices'],
			queryFn: async () => {
				const { data, error } = await recorderService().enumerateDevices();
				if (error) {
					return WhisperingErr({
						title: '❌ Failed to enumerate devices',
						serviceError: error,
					});
				}
				return Ok(data);
			},
		}),

		async startRecording({ toastId }: { toastId: string }) {
			const recordingId = nanoid();
			_currentRecordingId = recordingId;

			const params = await buildStartParams(recordingId);
			const { data: deviceAcquisitionOutcome, error: startRecordingError } =
				await recorderService().startRecording(params, {
					sendStatus: (options) => notify.loading({ id: toastId, ...options }),
				});

			if (startRecordingError) {
				_currentRecordingId = null;
				return WhisperingErr({
					title: '❌ Failed to start recording',
					serviceError: startRecordingError,
				});
			}

			_state = 'RECORDING';
			return Ok(deviceAcquisitionOutcome);
		},

		async stopRecording({ toastId }: { toastId: string }) {
			const { data: blob, error: stopRecordingError } =
				await recorderService().stopRecording({
					sendStatus: (options) => notify.loading({ id: toastId, ...options }),
				});

			const recordingId = _currentRecordingId;
			_currentRecordingId = null;
			_state = 'IDLE';

			if (stopRecordingError) {
				return WhisperingErr({
					title: '❌ Failed to stop recording',
					serviceError: stopRecordingError,
				});
			}

			if (!recordingId) {
				return WhisperingErr({
					title: '❌ Missing recording ID',
					description:
						'An internal error occurred: recording ID was not set when stopping the recording.',
				});
			}

			return Ok({ blob, recordingId });
		},

		async cancelRecording({ toastId }: { toastId: string }) {
			const { data: cancelResult, error: cancelRecordingError } =
				await recorderService().cancelRecording({
					sendStatus: (options) => notify.loading({ id: toastId, ...options }),
				});

			_currentRecordingId = null;
			_state = 'IDLE';

			if (cancelRecordingError) {
				return WhisperingErr({
					title: '❌ Failed to cancel recording',
					serviceError: cancelRecordingError,
				});
			}

			return Ok(cancelResult);
		},
	};
}

export const manualRecorder = createManualRecorder();
