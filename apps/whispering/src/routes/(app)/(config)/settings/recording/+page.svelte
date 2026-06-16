<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Link } from '@epicenter/ui/link';
	import InfoIcon from '@lucide/svelte/icons/info';
	import { createMutation } from '@tanstack/svelte-query';
	import { mutationOptions } from 'wellcrafted/query';
	import { SettingSelect } from '$lib/components/settings';
	import {
		BITRATE_OPTIONS,
		RECORDING_TRIGGER_OPTIONS,
		SAMPLE_RATE_OPTIONS,
	} from '$lib/constants/audio';
	import { os } from '#platform/os';
	import { asDeviceIdentifier } from '$lib/services/recorder/types';
	import { report } from '$lib/report';
	import { tauri } from '#platform/tauri';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { manualRecorderConfig } from '#platform/manual-recorder-config';
	import { settings } from '$lib/state/settings.svelte';
	import { whispering } from '#platform/whispering';
	import ManualSelectRecordingDevice from './ManualSelectRecordingDevice.svelte';
	import VadSelectRecordingDevice from './VadSelectRecordingDevice.svelte';

	const exportMarkdown = createMutation(() =>
		mutationOptions({
			mutationKey: ['recordings', 'exportMarkdown'],
			mutationFn: whispering.actions.recordings_export_markdown,
		}),
	);
</script>

<svelte:head> <title>Recording Settings - Whispering</title> </svelte:head>

<Field.Set>
	<Field.Legend>Recording</Field.Legend>
	<Field.Description>
		Configure your Whispering recording preferences.
	</Field.Description>
	<Field.Separator />
	<Field.Group>
		<SettingSelect
			store={settings}
			key="recording.trigger"
			label="Recording Trigger"
			items={RECORDING_TRIGGER_OPTIONS}
			description="Choose how recording starts: {RECORDING_TRIGGER_OPTIONS.map(
				(option) => option.label.toLowerCase(),
			).join(', ')}"
		/>

		{#if settings.get('recording.trigger') === 'manual'}
			<ManualSelectRecordingDevice
				bind:selected={() => {
					const selected = manualRecorderConfig.deviceId;
					return selected ? asDeviceIdentifier(selected) : null;
					},
					(selected) => (manualRecorderConfig.deviceId = selected)}
			/>
		{:else if settings.get('recording.trigger') === 'vad'}
			{#if os.isLinux}
				<Alert.Root class="border-red-500/20 bg-red-500/5">
					<InfoIcon class="size-4 text-red-600 dark:text-red-400" />
					<Alert.Title class="text-red-600 dark:text-red-400">
						VAD Mode Not Supported on Linux
					</Alert.Title>
					<Alert.Description>
						Voice Activated Detection (VAD) mode requires the browser's
						Navigator API, which is not fully supported in Tauri on Linux.
						Device enumeration and recording will fail. Please use Manual
						recording mode instead.
						<Link
							href="https://github.com/EpicenterHQ/epicenter/issues/839"
							target="_blank"
							class="font-medium underline underline-offset-4 hover:text-red-700 dark:hover:text-red-300"
						>
							Learn more →
						</Link>
					</Alert.Description>
				</Alert.Root>
			{:else}
				{#if tauri && os.isApple}
					<Alert.Root class="border-warning/20 bg-warning/5">
						<InfoIcon class="size-4 text-warning dark:text-warning" />
						<Alert.Title class="text-warning dark:text-warning">
							Global Shortcuts May Be Unreliable
						</Alert.Title>
						<Alert.Description>
							VAD uses browser-owned capture. macOS App Nap may delay browser
							recording logic when Whispering is not in focus.
						</Alert.Description>
					</Alert.Root>
				{/if}
				<Alert.Root class="border-blue-500/20 bg-blue-500/5">
					<InfoIcon class="size-4 text-blue-600 dark:text-blue-400" />
					<Alert.Title class="text-blue-600 dark:text-blue-400">
						Voice Activated Detection Mode
					</Alert.Title>
					<Alert.Description>
						VAD mode uses the browser's Web Audio API for real-time voice
						detection. Captured speech is encoded to uncompressed WAV format.
					</Alert.Description>
				</Alert.Root>
			{/if}

			<VadSelectRecordingDevice
				bind:selected={() => {
					const selected = deviceConfig.get('recording.navigator.deviceId');
					return selected ? asDeviceIdentifier(selected) : null;
					},
					(selected) =>
						deviceConfig.set('recording.navigator.deviceId', selected)}
			/>
		{/if}

		{#if tauri}
			<Field.Field>
				<Field.Label>Recording markdown export</Field.Label>
				<Button
					variant="outline"
					onclick={() => {
						exportMarkdown.mutate(undefined, {
							onSuccess: (data) => {
								if (data.status === 'cancelled') return;

								report.success({
									title: 'Recording markdown exported',
									description: `Wrote ${data.written} ${data.written === 1 ? 'file' : 'files'} to ${data.dir}.`,
								});
							},
							onError: (error) => {
								report.error({
									title: 'Recording markdown export failed',
									cause: error,
								});
							},
						});
					}}
					disabled={exportMarkdown.isPending}
				>
					{exportMarkdown.isPending ? 'Exporting...' : 'Export markdown...'}
				</Button>
				<Field.Description>
					Write every current recording's transcript to a folder you choose. The
					files are snapshots: later edits in Whispering do not update them. Run
					the export again to refresh.
				</Field.Description>
			</Field.Field>
		{/if}

		{#if settings.get('recording.trigger') === 'manual'}
			{#if !tauri}
				<SettingSelect
					store={deviceConfig}
					key="recording.navigator.bitrateKbps"
					label="Bitrate"
					items={BITRATE_OPTIONS}
					description="The bitrate of the recording. Higher values mean better quality but larger file sizes."
				/>
			{:else}
				<SettingSelect
					store={deviceConfig}
					key="recording.cpal.sampleRate"
					label="Sample Rate"
					items={SAMPLE_RATE_OPTIONS}
					description="Higher sample rates provide better quality but create larger files"
				/>
			{/if}
		{/if}
	</Field.Group>
</Field.Set>
