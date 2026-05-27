<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import X from '@lucide/svelte/icons/x';
	import { report } from '$lib/report';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { tauri } from '$lib/tauri';

	const exportDir = $derived(deviceConfig.get('recording.markdownExportDir'));

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
