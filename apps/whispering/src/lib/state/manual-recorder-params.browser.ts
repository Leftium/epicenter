import {
	asDeviceIdentifier,
	type NavigatorRecordingParams,
} from '$lib/services/recorder/types';
import { deviceConfig } from '$lib/state/device-config.svelte';

export function buildManualStartParams(
	recordingId: string,
): NavigatorRecordingParams {
	const deviceId = deviceConfig.get('recording.navigator.deviceId');
	return {
		recordingId,
		selectedDeviceId: deviceId ? asDeviceIdentifier(deviceId) : null,
		bitrateKbps: deviceConfig.get('recording.navigator.bitrateKbps'),
	};
}
