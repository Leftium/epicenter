import { nanoid } from 'nanoid/non-secure';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok } from 'wellcrafted/result';
import type { WhisperingRecordingState } from '$lib/constants/audio';
import { defineQuery } from '$lib/rpc/client';
import { services } from '$lib/services';
import { CpalRecorderServiceLive } from '$lib/services/recorder';
import {
	asDeviceIdentifier,
	type RecorderService,
	type Recording,
	type StartRecordingParams,
	type UpdateStatusMessageFn,
} from '$lib/services/recorder/types';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { tauri } from '$lib/tauri';

const ManualRecorderError = defineErrors({
	EnumerateDevicesFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to enumerate devices: ${extractErrorMessage(cause)}`,
		cause,
	}),
	AlreadyRecording: () => ({
		message:
			'A recording is already in progress. Stop the current one before starting a new one.',
	}),
	NoActiveRecording: () => ({
		message: 'No active recording session to stop. Start a recording first.',
	}),
});

/**
 * Creates the manual recorder with reactive state.
 *
 * State is owned by this module via Svelte's `$state` rune for synchronous
 * reactivity. Mirrors the shape of `vadRecorder` in `vad-recorder.svelte.ts`:
 *
 * - Reactive access: `manualRecorder.state` (triggers effects on change)
 * - Operations: `manualRecorder.startRecording({ sendStatus })` etc.
 * - Device enumeration as a TanStack Query for loading states in selectors
 *
 * Each recording is a `Recording` object returned by the backend that
 * started it. The Recording owns its own stop/cancel/subscribe; the
 * recorder service is only consulted at start time, so toggling
 * `recording.method` mid-recording can't misroute teardown (the in-flight
 * Recording stays bound to its original backend).
 *
 * Subscription is per-Recording rather than per-service. The previous
 * model subscribed to both navigator and cpal at module init even though
 * only one would ever fire; now `attach()` subscribes to the live
 * Recording and `detach()` cleans up on stop/cancel.
 *
 * On Tauri, state is bootstrapped from each backend's `getActiveRecording`
 * at module init (a Rust CPAL session can outlive a JS reload).
 */

function resolveServiceForStart(): RecorderService {
	// CpalRecorderServiceLive is null on web (build-time fact); even when
	// non-null, the runtime setting decides whether to use it.
	if (
		CpalRecorderServiceLive &&
		deviceConfig.get('recording.method') === 'cpal'
	) {
		return CpalRecorderServiceLive;
	}
	return services.navigatorRecorder;
}

async function buildStartParams(
	recordingId: string,
): Promise<StartRecordingParams> {
	const useCpal = !!tauri && deviceConfig.get('recording.method') === 'cpal';

	if (useCpal) {
		const deviceId = deviceConfig.get('recording.cpal.deviceId');
		return {
			method: 'cpal',
			recordingId,
			selectedDeviceId: deviceId ? asDeviceIdentifier(deviceId) : null,
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
	let _current: Recording | null = null;
	let _unsubscribe: (() => void) | null = null;

	function attach(recording: Recording) {
		_unsubscribe?.();
		_current = recording;
		_unsubscribe = recording.subscribe((s) => {
			_state = s;
			if (s === 'IDLE') detach();
		});
	}

	function detach() {
		_unsubscribe?.();
		_unsubscribe = null;
		_current = null;
		_state = 'IDLE';
	}

	// Bootstrap: ask each backend whether it owns a live session. Navigator
	// always returns null after a JS reload (its state lives in the closure);
	// cpal can return non-null because the Rust process keeps the stream alive.
	//
	// The promise is awaited before any stop/cancel/start runs. Without
	// that gate, a user action that fires before bootstrap resolves sees a
	// stale `_current === null` and either no-ops the cancel (leaking the
	// Rust session) or double-starts on top of a rehydrated one.
	const bootstrapped = Promise.all([
		services.navigatorRecorder.getActiveRecording(),
		CpalRecorderServiceLive
			? CpalRecorderServiceLive.getActiveRecording()
			: Promise.resolve({ data: null, error: null } as const),
	]).then(([nav, cpal]) => {
		const found = nav.data ?? cpal.data ?? null;
		if (found) attach(found);
	});

	return {
		get state(): WhisperingRecordingState {
			return _state;
		},

		enumerateDevices: defineQuery({
			queryKey: ['recorder', 'devices'],
			queryFn: async () => {
				const { data, error } =
					await resolveServiceForStart().enumerateDevices();
				if (error)
					return ManualRecorderError.EnumerateDevicesFailed({ cause: error });
				return Ok(data);
			},
		}),

		async startRecording({ sendStatus }: { sendStatus: UpdateStatusMessageFn }) {
			await bootstrapped;
			if (_current) return ManualRecorderError.AlreadyRecording();
			const service = resolveServiceForStart();
			const params = await buildStartParams(nanoid());
			const { data, error: startRecordingError } = await service.startRecording(
				params,
				{ sendStatus },
			);

			if (startRecordingError) return Err(startRecordingError);

			attach(data.recording);
			return Ok(data.deviceAcquisition);
		},

		async stopRecording({ sendStatus }: { sendStatus: UpdateStatusMessageFn }) {
			await bootstrapped;
			if (!_current) return ManualRecorderError.NoActiveRecording();
			const { data, error: stopRecordingError } = await _current.stop({
				sendStatus,
			});

			if (stopRecordingError) return Err(stopRecordingError);

			return Ok(data);
		},

		async cancelRecording({
			sendStatus,
		}: { sendStatus: UpdateStatusMessageFn }) {
			await bootstrapped;
			if (!_current) return Ok({ status: 'no-recording' as const });
			const { data: cancelResult, error: cancelRecordingError } =
				await _current.cancel({ sendStatus });

			if (cancelRecordingError) return Err(cancelRecordingError);

			return Ok(cancelResult);
		},
	};
}

export const manualRecorder = createManualRecorder();
