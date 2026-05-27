<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import AlertCircle from '@lucide/svelte/icons/alert-circle';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import X from '@lucide/svelte/icons/x';
	import { onDestroy } from 'svelte';
	import { report } from '$lib/report';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { tauri } from '$lib/tauri';
	import type { RecordingMarkdownExport } from '$lib/recording-markdown-export';
	import { whispering } from '$lib/whispering/client';

	const exportDir = $derived(deviceConfig.get('recording.markdownExportDir'));
	const recordingsExport = whispering.recordingsExport;
	let currentExport = $state<RecordingMarkdownExport | null>(null);
	let lastError = $state<{ at: Date; error: unknown } | null>(null);
	let unobserveLastError: (() => void) | undefined;

	const unobserveExport = recordingsExport.subscribe((nextExport) => {
		currentExport = nextExport;
		lastError = null;
		unobserveLastError?.();
		unobserveLastError = nextExport?.lastError.subscribe((error) => {
			lastError = error;
		});
	});

	onDestroy(() => {
		unobserveExport();
		unobserveLastError?.();
	});

	const lastErrorMessage = $derived(
		lastError?.error instanceof Error
			? lastError.error.message
			: 'Could not write markdown files.',
	);

	async function chooseExportFolder() {
		if (!tauri) return;

		try {
			const { open } = await import('@tauri-apps/plugin-dialog');
			const selected = await open({
				directory: true,
				multiple: false,
				title: 'Choose recording markdown export folder',
			});

			if (selected) deviceConfig.set('recording.markdownExportDir', selected);
		} catch (error) {
			report.error({
				title: 'Failed to choose export folder',
				cause: {
					name: 'ChooseExportFolderFailed',
					message: error instanceof Error ? error.message : 'Unknown error',
				},
			});
		}
	}
</script>

<div class="flex flex-col gap-2">
	<div class="flex items-center gap-2">
		<Input
			type="text"
			value={exportDir ?? ''}
			placeholder="No folder selected"
			readonly
			class="flex-1"
		/>

		<Button
			tooltip="Choose folder"
			variant="outline"
			size="icon"
			onclick={chooseExportFolder}
		>
			<FolderOpen class="size-4" />
		</Button>

		{#if exportDir}
			<Button
				tooltip="Clear folder"
				variant="outline"
				size="icon"
				onclick={() => {
					deviceConfig.set('recording.markdownExportDir', null);
				}}
			>
				<X class="size-4" />
			</Button>
		{/if}
	</div>

	{#if currentExport && lastError}
		<Alert.Root class="border-destructive/30 bg-destructive/5">
			<AlertCircle class="size-4 text-destructive" />
			<Alert.Title>Markdown export needs attention</Alert.Title>
			<Alert.Description>
				{lastErrorMessage}
			</Alert.Description>
		</Alert.Root>
	{/if}
</div>
