<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Command from '@epicenter/ui/command';
	import { useCombobox } from '@epicenter/ui/hooks';
	import * as Popover from '@epicenter/ui/popover';
	import { Spinner } from '@epicenter/ui/spinner';
	import { cn } from '@epicenter/ui/utils';
	import CheckIcon from '@lucide/svelte/icons/check';
	import MicIcon from '@lucide/svelte/icons/mic';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { createQuery } from '@tanstack/svelte-query';
	import { report } from '$lib/report';
	import { tauri } from '$lib/tauri';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { manualRecorder } from '$lib/state/manual-recorder.svelte';

	const combobox = useCombobox();

	const selectedDeviceKey = $derived(
		tauri ? 'recording.cpal.deviceId' : 'recording.navigator.deviceId',
	);
	const selectedDeviceId = $derived(
		deviceConfig.get(selectedDeviceKey),
	);

	const isDeviceSelected = $derived(!!selectedDeviceId);

	const recorderLabel = $derived(tauri ? 'CPAL' : 'Navigator');

	const getDevicesQuery = createQuery(() => ({
		...manualRecorder.enumerateDevices.options,
		enabled: combobox.open,
	}));

	$effect(() => {
		if (getDevicesQuery.isError) {
			report.info({ cause: getDevicesQuery.error });
		}
	});
</script>

<Popover.Root bind:open={combobox.open}>
	<Popover.Trigger bind:ref={combobox.triggerRef}>
		{#snippet child({ props })}
			<Button
				{...props}
				tooltip={isDeviceSelected
					? `Change ${recorderLabel} recording device`
					: `Select ${recorderLabel} recording device`}
				role="combobox"
				aria-expanded={combobox.open}
				variant="ghost"
				size="icon"
			>
				{#if isDeviceSelected}
					<MicIcon class="size-4 text-green-500" />
				{:else}
					<MicIcon class="size-4 text-warning" />
				{/if}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="p-0">
		<Command.Root loop>
			<Command.Input placeholder="Search devices..." />
			<Command.List class="max-h-[40vh]">
				<Command.Empty>No recording devices found.</Command.Empty>

				<Command.Group heading="Recording Device">
					{#if getDevicesQuery.isPending}
						<div class="p-4 text-center text-sm text-muted-foreground">
							Loading devices...
						</div>
					{:else if getDevicesQuery.isError}
						<div class="p-4 text-center text-sm text-destructive">
							{getDevicesQuery.error.message}
						</div>
					{:else}
						{#each getDevicesQuery.data as device (device.id)}
							<Command.Item
								value={`device-${device.id} ${device.label}`}
								onSelect={() => {
									const currentDeviceId = selectedDeviceId;
									deviceConfig.set(
										selectedDeviceKey,
										currentDeviceId === device.id ? null : device.id,
									);
								}}
								class="flex items-center gap-3 px-3 py-2"
							>
								<CheckIcon
									class={cn(
										'size-4 shrink-0',
										selectedDeviceId === device.id
											? 'opacity-100'
											: 'opacity-0',
									)}
								/>
								<span class="flex-1 text-sm">{device.label}</span>
							</Command.Item>
						{/each}
					{/if}
				</Command.Group>
				<Command.Separator />
				<Command.Group>
					<Command.Item
						onSelect={() => {
							getDevicesQuery.refetch();
						}}
					>
						{#if getDevicesQuery.isRefetching}
							<Spinner />
						{:else}
							<RefreshCwIcon class="size-4" />
						{/if}
						Refresh devices
					</Command.Item>
				</Command.Group>
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>
