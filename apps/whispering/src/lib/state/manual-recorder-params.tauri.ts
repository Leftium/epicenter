import {
	asDeviceIdentifier,
	type CpalRecordingParams,
} from '$lib/services/recorder/types';
import { deviceConfig } from '$lib/state/device-config.svelte';

export const MANUAL_DEVICE_ID_KEY = 'recording.cpal.deviceId';

export function buildManualStartParams(
	recordingId: string,
): CpalRecordingParams {
	const deviceId = deviceConfig.get(MANUAL_DEVICE_ID_KEY);
	return {
		recordingId,
		selectedDeviceId: deviceId ? asDeviceIdentifier(deviceId) : null,
		sampleRate: deviceConfig.get('recording.cpal.sampleRate'),
	};
}
