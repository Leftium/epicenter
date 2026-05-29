import {
	asDeviceIdentifier,
	type NavigatorRecordingParams,
} from '$lib/services/recorder/types';
import { deviceConfig } from '$lib/state/device-config.svelte';

export const MANUAL_DEVICE_ID_KEY = 'recording.navigator.deviceId';

export function buildManualStartParams(
	recordingId: string,
): NavigatorRecordingParams {
	const deviceId = deviceConfig.get(MANUAL_DEVICE_ID_KEY);
	return {
		recordingId,
		selectedDeviceId: deviceId ? asDeviceIdentifier(deviceId) : null,
		bitrateKbps: deviceConfig.get('recording.navigator.bitrateKbps'),
	};
}
