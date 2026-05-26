import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { nanoid } from 'nanoid/non-secure';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type {
	CancelRecordingResult,
	WhisperingRecordingState,
} from '$lib/constants/audio';
import { PATHS } from '$lib/constants/paths';
import { defineQuery } from '$lib/query/client';
import { WhisperingErr } from '$lib/result';
import { services } from '$lib/services';
import { desktopServices } from '$lib/services/desktop';
import {
	asDeviceIdentifier,
	type DeviceAcquisitionOutcome,
	type RecorderError,
	type StartRecordingParams,
	type UpdateStatusMessageFn,
} from '$lib/services/recorder/types';
import { deviceConfig } from '$lib/state/device-config.svelte';

/**
 * Toast-agnostic manual recorder.
 *
 * Owns reactive state, an internal busy mutex, and start-time tracking. Takes
 * a generic `sendStatus` progress callback so callers (notify, log, etc.)
 * decide how progress surfaces to the user.
 *
 * On Tauri, state is bootstrapped from the active service's `getRecorderState`
 * once at module init (a Rust CPAL session can outlive a JS reload). A Tauri
 * `recorder:state-changed` listener is registered to receive future Rust-side
 * transitions.
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
	// Internal mutex: covers the window between calling the recorder service
	// and the service returning, during which _state hasn't been updated yet.
	let _busy = false;
	let _startedAt: number | null = null;

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

		/**
		 * Returns Ok(null) if the recorder is busy or not idle; the caller should
		 * treat that as a no-op (no toast, no error). Returns Err only for
		 * actual service failures.
		 */
		async start({
			sendStatus,
		}: {
			sendStatus: UpdateStatusMessageFn;
		}): Promise<Result<DeviceAcquisitionOutcome | null, RecorderError>> {
			if (_busy || _state !== 'IDLE') {
				console.info('Recorder not idle, ignoring start');
				return Ok(null);
			}
			_busy = true;

			const params = await buildStartParams(nanoid());
			const { data: outcome, error } = await recorderService().startRecording(
				params,
				{ sendStatus },
			);

			_busy = false;

			if (error) return Err(error);

			_state = 'RECORDING';
			_startedAt = Date.now();
			return Ok(outcome);
		},

		/**
		 * Returns Ok(null) if the recorder is busy; the caller should treat that
		 * as a no-op. Returns Err only for actual service failures.
		 */
		async stop({
			sendStatus,
		}: {
			sendStatus: UpdateStatusMessageFn;
		}): Promise<
			Result<
				{ blob: Blob; recordingId: string; duration: number | undefined } | null,
				RecorderError
			>
		> {
			if (_busy) {
				console.info('Recorder busy, ignoring stop');
				return Ok(null);
			}
			_busy = true;

			const { data, error } = await recorderService().stopRecording({
				sendStatus,
			});

			_busy = false;

			if (error) return Err(error);

			const duration = _startedAt ? Date.now() - _startedAt : undefined;
			_state = 'IDLE';
			_startedAt = null;

			return Ok({ ...data, duration });
		},

		/**
		 * Returns Ok(null) if the recorder is busy; the caller should treat that
		 * as a no-op. Returns Err only for actual service failures.
		 */
		async cancel({
			sendStatus,
		}: {
			sendStatus: UpdateStatusMessageFn;
		}): Promise<Result<CancelRecordingResult | null, RecorderError>> {
			if (_busy) {
				console.info('Recorder busy, ignoring cancel');
				return Ok(null);
			}
			_busy = true;

			const { data, error } = await recorderService().cancelRecording({
				sendStatus,
			});

			_busy = false;

			if (error) return Err(error);

			_state = 'IDLE';
			_startedAt = null;
			return Ok(data);
		},
	};
}

export const manualRecorder = createManualRecorder();
