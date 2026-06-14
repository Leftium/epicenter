<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Progress } from '@epicenter/ui/progress';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import CheckIcon from '@lucide/svelte/icons/check';
	import Download from '@lucide/svelte/icons/download';
	import X from '@lucide/svelte/icons/x';
	import { type LocalModelConfig } from '$lib/constants/local-models';
	import { localModelDownloads } from '$lib/state/local-model-downloads.svelte';

	let {
		model,
		active = false,
		recommended = false,
		onActivate,
		onClearSelection,
		onDiskChange,
	}: {
		model: LocalModelConfig;
		/** Whether this catalog model is the selected folder entry. */
		active?: boolean;
		/** Show the Recommended badge; the selector decides when it guides a choice. */
		recommended?: boolean;
		/** Select this model's folder entry through the parent bind:value. */
		onActivate: () => void | Promise<void>;
		/** Clear the parent selection after deleting the active entry. */
		onClearSelection: () => void | Promise<void>;
		/** Re-scan the parent selector after this card changes the models folder. */
		onDiskChange: () => void | Promise<void>;
	} = $props();

	// Shared per-model handle: the selector hero reads the same one, so a
	// download started in either place shows its progress in both.
	const download = $derived(localModelDownloads.get(model));

	// Aliased so the template narrows the union per branch.
	const modelState = $derived(download.state);
	const isActive = $derived(active && modelState.type === 'ready');

	async function downloadModel() {
		const result = await download.download();
		if (!result) return;
		if (result.error) {
			toast.error('Failed to download model', {
				description: result.error.message,
			});
			return;
		}

		await onActivate();
		await onDiskChange();
		toast.success(
			result.data.outcome === 'already-installed'
				? 'Model already downloaded and activated'
				: 'Model downloaded and activated successfully',
		);
	}

	async function deleteModel() {
		const { error } = await download.delete();
		if (error) {
			toast.error('Failed to delete model', {
				description: error.message,
			});
			return;
		}
		if (active) {
			await onClearSelection();
		}
		await onDiskChange();
		toast.success('Model deleted');
	}

	async function activateModel() {
		await onActivate();
		toast.success('Model activated');
	}
</script>

<div
	class="flex items-center gap-3 p-3 rounded-lg border {isActive
		? 'border-primary bg-primary/5'
		: ''}"
>
	<div class="flex-1">
		<div class="flex items-center gap-2">
			<span class="font-medium">{model.name}</span>
			{#if recommended}
				<Badge variant="outline" class="text-xs">Recommended</Badge>
			{/if}
			{#if isActive}
				<Badge variant="default" class="text-xs">Active</Badge>
			{:else if modelState.type === 'ready'}
				<Badge variant="secondary" class="text-xs">Downloaded</Badge>
			{/if}
		</div>
		<div class="text-sm text-muted-foreground">{model.description}</div>
		<div class="text-xs text-muted-foreground mt-1">{model.size}</div>
	</div>

	<div class="flex items-center gap-2">
		{#if modelState.type === 'downloading'}
			<div class="flex items-center gap-2 min-w-[120px]">
				<Spinner />
				<span class="text-sm font-medium">{modelState.progress}%</span>
			</div>
		{:else if modelState.type === 'ready'}
			{#if isActive}
				<Button size="sm" variant="default" disabled>
					<CheckIcon class="size-4 mr-1" />
					Activated
				</Button>
			{:else}
				<Button size="sm" variant="outline" onclick={activateModel}>
					Activate
				</Button>
			{/if}
			<Button size="sm" variant="ghost" onclick={deleteModel}>
				<X class="size-4" />
			</Button>
		{:else}
			<Button size="sm" variant="outline" onclick={downloadModel}>
				<Download class="size-4" />
				Download
			</Button>
		{/if}
	</div>
</div>

{#if modelState.type === 'downloading' && modelState.progress > 0}
	<Progress value={modelState.progress} class="mt-2 h-2" />
{/if}
