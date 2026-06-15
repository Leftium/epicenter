<!-- Recording-access step: macOS permissions + device picker. -->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';
	import CheckCircle2Icon from '@lucide/svelte/icons/check-circle-2';
	import MicIcon from '@lucide/svelte/icons/mic';
	import { manualRecorderConfig } from '#platform/manual-recorder-config';
	import MacosAccessibilityGuide from '$lib/components/MacosAccessibilityGuide.svelte';
	import { asDeviceIdentifier } from '$lib/services/recorder/types';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import ManualSelectRecordingDevice from '../settings/recording/ManualSelectRecordingDevice.svelte';
	import VadSelectRecordingDevice from '../settings/recording/VadSelectRecordingDevice.svelte';
	import { isAppleDesktop } from '$lib/setup/setup-readiness';
	import type {
		Permissions,
		PermissionStatus,
	} from '$lib/state/permissions.svelte';

	let { permissions }: { permissions: Permissions } = $props();

	const selectedRecordingMode = $derived(settings.get('recording.mode'));
</script>

<div class="space-y-4">
	{#if isAppleDesktop}
		<div class="grid gap-3 sm:grid-cols-2">
			{@render permissionPanel({
				title: 'Microphone',
				description: 'Needed for live recording and practice.',
				state: permissions.microphone,
				actionLabel: 'Request microphone',
				onclick: () => permissions.requestMicrophone(),
			})}
			{@render permissionPanel({
				title: 'Accessibility',
				description: 'Needed for app-wide dictation output.',
				state: permissions.accessibility,
				actionLabel: 'Request access',
				onclick: () => permissions.requestAccessibility(),
			})}
		</div>

		<!-- When Accessibility is still ungranted, the remove/re-add dance is
		usually the fix; render the shared guide inline rather than sending a
		first-run user off to a separate page. -->
		{#if permissions.accessibility !== 'granted'}
			<MacosAccessibilityGuide />
		{/if}
	{/if}

	{#if selectedRecordingMode === 'manual'}
		<ManualSelectRecordingDevice
			bind:selected={() => {
				const selected = manualRecorderConfig.deviceId;
				return selected ? asDeviceIdentifier(selected) : null;
				},
				(selected) => (manualRecorderConfig.deviceId = selected)}
		/>
	{:else if selectedRecordingMode === 'vad'}
		<VadSelectRecordingDevice
			bind:selected={() => {
				const selected = deviceConfig.get('recording.navigator.deviceId');
				return selected ? asDeviceIdentifier(selected) : null;
				},
				(selected) =>
					deviceConfig.set('recording.navigator.deviceId', selected)}
		/>
	{:else}
		<Alert.Root>
			<MicIcon class="size-4" />
			<Alert.Title>Upload mode selected</Alert.Title>
			<Alert.Description>
				Upload mode does not need a microphone. Switch to Manual or Voice
				Activated when you want live dictation.
			</Alert.Description>
		</Alert.Root>
	{/if}
</div>

{#snippet permissionPanel({
	title,
	description,
	state,
	actionLabel,
	onclick,
}: {
	title: string;
	description: string;
	state: PermissionStatus;
	actionLabel: string;
	onclick: () => void | Promise<void>;
})}
	<div class="rounded-lg border p-4">
		<div class="flex items-start justify-between gap-3">
			<div>
				<p class="text-sm font-medium">{title}</p>
				<p class="text-sm text-muted-foreground">{description}</p>
			</div>
			{#if state === 'granted'}
				<CheckCircle2Icon class="size-5 shrink-0 text-green-500" />
			{:else}
				<AlertCircleIcon class="size-5 shrink-0 text-warning" />
			{/if}
		</div>
		{#if state !== 'granted'}
			<div class="mt-3 flex flex-wrap gap-2">
				<Button size="sm" variant="outline" {onclick}>
					{actionLabel}
				</Button>
			</div>
		{/if}
	</div>
{/snippet}
