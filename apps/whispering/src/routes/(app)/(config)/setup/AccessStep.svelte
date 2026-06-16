<!-- Recording-access step: macOS permissions + device picker. -->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';
	import CheckCircle2Icon from '@lucide/svelte/icons/check-circle-2';
	import { manualRecorderConfig } from '#platform/manual-recorder-config';
	import { asDeviceIdentifier } from '$lib/services/recorder/types';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import ManualSelectRecordingDevice from '../settings/recording/ManualSelectRecordingDevice.svelte';
	import VadSelectRecordingDevice from '../settings/recording/VadSelectRecordingDevice.svelte';
	import {
		isAppleDesktop,
		type SetupPermissionState,
	} from '$lib/setup/setup-readiness';
	import type { SetupPermissions } from './setup-permissions.svelte';

	let { permissions }: { permissions: SetupPermissions } = $props();

	const selectedRecordingTrigger = $derived(settings.get('recording.trigger'));
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
				guideHref: '/macos-enable-accessibility',
			})}
		</div>
	{/if}

	{#if selectedRecordingTrigger === 'manual'}
		<ManualSelectRecordingDevice
			bind:selected={() => {
				const selected = manualRecorderConfig.deviceId;
				return selected ? asDeviceIdentifier(selected) : null;
				},
				(selected) => (manualRecorderConfig.deviceId = selected)}
		/>
	{:else}
		<VadSelectRecordingDevice
			bind:selected={() => {
				const selected = deviceConfig.get('recording.navigator.deviceId');
				return selected ? asDeviceIdentifier(selected) : null;
				},
				(selected) =>
					deviceConfig.set('recording.navigator.deviceId', selected)}
		/>
	{/if}
</div>

{#snippet permissionPanel({
	title,
	description,
	state,
	actionLabel,
	onclick,
	guideHref,
}: {
	title: string;
	description: string;
	state: SetupPermissionState;
	actionLabel: string;
	onclick: () => void | Promise<void>;
	guideHref?: string;
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
				{#if guideHref}
					<Button size="sm" variant="ghost" href={guideHref}>View guide</Button>
				{/if}
			</div>
		{/if}
	</div>
{/snippet}
