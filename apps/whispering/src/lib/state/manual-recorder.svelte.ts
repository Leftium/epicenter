import { isTauri } from '@tauri-apps/api/core';
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
	type RecorderService,
	type StartRecordingParams,
} from '$lib/services/recorder/types';
import { deviceConfig } from '$lib/state/device-config.svelte';

/**
 * Creates the manual recorder with reactive state.
 *
 * State is owned by this module via Svelte's `$state` rune for synchronous
 * reactivity. Mirrors the shape of `vadRecorder` in `vad-recorder.svelte.ts`:
 *
 * - Reactive access: `manualRecorder.state` (triggers effects on change)
 * - Operations: `manualRecorder.startRecording({ toastId })` etc.
 * - Device enumeration as a TanStack Query for loading states in selectors
 *
 * State writes flow through a single channel: every recorder service exposes
 * `subscribe(handler)`, this module registers one handler at construction
 * time, and the active service drives `_state` directly. Inactive services
 * (e.g. a CPAL subscription in web mode) emit nothing.
 *
 * On Tauri, state is bootstrapped from the active service's `getRecorderState`
 * once at module init (a Rust CPAL session can outlive a JS reload). The
 * subscribe handler covers every subsequent transition, including ones Rust
 * initiates without a JS command (future auto-stop, device disconnect, etc.).
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
	const useCpal = isTauri() && deviceConfig.get('recording.method') === 'cpal';

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

	/**
	 * Tracks the service that owns the in-flight recording so stop/cancel
	 * route to the same backend that started it.
	 *
	 * Without this, toggling `recording.method` between start and stop would
	 * call stop on a backend that has no session (failing with NotRecording)
	 * while leaving the original backend's stream/MediaRecorder alive and the
	 * mic LED on. The bug is rare in click-driven UI but real for hotkey
	 * flows where the recording is invisible. Resolving the service once at
	 * start time and binding it to the lifecycle makes mid-recording toggles
	 * a no-op for the in-flight session; the next start picks up the new
	 * setting normally.
	 */
	let _activeService: RecorderService | null = null;

	// Bootstrap: only cpal can outlive a JS reload (Rust process keeps the
	// stream), so probe cpal directly rather than going through the current
	// setting. If the user toggled to navigator after a reload but a cpal
	// recording is still live, we still bind to cpal for the rest of its life.
	if (isTauri()) {
		void desktopServices.cpalRecorder.getRecorderState().then(({ data }) => {
			if (data === 'RECORDING') {
				_activeService = desktopServices.cpalRecorder;
				_state = 'RECORDING';
			}
		});
	}

	const writeState = (state: WhisperingRecordingState) => {
		_state = state;
	};
	services.navigatorRecorder.subscribe(writeState);
	if (isTauri()) desktopServices.cpalRecorder.subscribe(writeState);

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
			const params = await buildStartParams(nanoid());
			const service = recorderService();
			const { data: deviceAcquisitionOutcome, error: startRecordingError } =
				await service.startRecording(params, {
					sendStatus: (options) => notify.loading({ id: toastId, ...options }),
				});

			if (startRecordingError) {
				return WhisperingErr({
					title: '❌ Failed to start recording',
					serviceError: startRecordingError,
				});
			}

			_activeService = service;
			return Ok(deviceAcquisitionOutcome);
		},

		async stopRecording({ toastId }: { toastId: string }) {
			const service = _activeService ?? recorderService();
			const { data, error: stopRecordingError } = await service.stopRecording({
				sendStatus: (options) => notify.loading({ id: toastId, ...options }),
			});

			if (stopRecordingError) {
				return WhisperingErr({
					title: '❌ Failed to stop recording',
					serviceError: stopRecordingError,
				});
			}

			_activeService = null;
			return Ok(data);
		},

		async cancelRecording({ toastId }: { toastId: string }) {
			const service = _activeService ?? recorderService();
			const { data: cancelResult, error: cancelRecordingError } =
				await service.cancelRecording({
					sendStatus: (options) => notify.loading({ id: toastId, ...options }),
				});

			if (cancelRecordingError) {
				return WhisperingErr({
					title: '❌ Failed to cancel recording',
					serviceError: cancelRecordingError,
				});
			}

			_activeService = null;
			return Ok(cancelResult);
		},
	};
}

export const manualRecorder = createManualRecorder();
