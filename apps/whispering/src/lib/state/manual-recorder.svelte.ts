import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { nanoid } from 'nanoid/non-secure';
import { Ok } from 'wellcrafted/result';
import type { WhisperingRecordingState } from '$lib/constants/audio';
import { PATHS } from '$lib/constants/paths';
import { defineQuery } from '$lib/rpc/client';
import { WhisperingErr } from '$lib/result';
import { services } from '$lib/services';
import { desktopServices } from '$lib/services/desktop';
import {
	asDeviceIdentifier,
	type StartRecordingParams,
	type UpdateStatusMessageFn,
} from '$lib/services/recorder/types';
import { deviceConfig } from '$lib/state/device-config.svelte';

/**
 * Toast-agnostic manual recorder. Exposes the current recording state and
 * three thin wrappers around the active recorder service. State stays narrow
 * (`'IDLE' | 'RECORDING'`); the transient "operation in flight" window is
 * owned by the caller (a TanStack mutation in the UI layer), not modelled
 * here.
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

type Callbacks = { sendStatus: UpdateStatusMessageFn };

function createManualRecorder() {
	let _state = $state<WhisperingRecordingState>('IDLE');

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

		async start({ sendStatus }: Callbacks) {
			const result = await recorderService().startRecording(
				await buildStartParams(nanoid()),
				{ sendStatus },
			);
			if (result.data) _state = 'RECORDING';
			return result;
		},

		async stop({ sendStatus }: Callbacks) {
			const result = await recorderService().stopRecording({ sendStatus });
			if (result.data) _state = 'IDLE';
			return result;
		},

		async cancel({ sendStatus }: Callbacks) {
			const result = await recorderService().cancelRecording({ sendStatus });
			if (result.data) _state = 'IDLE';
			return result;
		},
	};
}

export const manualRecorder = createManualRecorder();
