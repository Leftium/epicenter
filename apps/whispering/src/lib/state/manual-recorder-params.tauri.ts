import {
	asDeviceIdentifier,
	type CpalRecordingParams,
} from '$lib/services/recorder/types';
import { deviceConfig } from '$lib/state/device-config.svelte';

export function buildManualStartParams(
	recordingId: string,
): CpalRecordingParams {
	const deviceId = deviceConfig.get('recording.cpal.deviceId');
	return {
		recordingId,
		selectedDeviceId: deviceId ? asDeviceIdentifier(deviceId) : null,
		sampleRate: deviceConfig.get('recording.cpal.sampleRate'),
	};
}
