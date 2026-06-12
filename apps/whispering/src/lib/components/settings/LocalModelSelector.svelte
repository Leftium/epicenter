<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as Field from '@epicenter/ui/field';
	import { toast } from '@epicenter/ui/sonner';
	import CheckIcon from '@lucide/svelte/icons/check';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import X from '@lucide/svelte/icons/x';
	import { mkdir } from '@tauri-apps/plugin-fs';
	import type { Snippet } from 'svelte';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { Ok, tryAsync } from 'wellcrafted/result';
	import {
		type LocalModelConfig,
		modelEntryName,
	} from '$lib/constants/local-models';
	import { PATHS } from '$lib/services/fs-paths';
	import {
		deleteModelEntry,
		listModelEntries,
		type LocalModelEntry,
	} from '$lib/services/transcription/local-model-folder';
	import { PROVIDERS } from '$lib/services/transcription/providers';
	import { tauri } from '#platform/tauri';
	import LocalModelDownloadCard from './LocalModelDownloadCard.svelte';

	/**
	 * One list backed by the engine's models folder: catalog models render as
	 * download cards, and every other folder entry (dropped in or symlinked
	 * by the user) renders as a selectable row. The bindable value is the
	 * active entry's name.
	 */
	type LocalModelSelectorProps = {
		/**
		 * Pre-built models available for download. All entries share one
		 * engine; at least one is required because the engine decides which
		 * models folder backs this list.
		 */
		models: readonly [LocalModelConfig, ...LocalModelConfig[]];

		/** Component title displayed in the card header */
		title: string;

		/** Component description displayed below the title */
		description: string;

		/** Bindable name of the active entry in the engine's models folder */
		value: string;

		/** Optional footer content (download sources, naming notes) */
		footer?: Snippet;
	};

	let {
		models,
		title,
		description,
		value = $bindable(),
		footer,
	}: LocalModelSelectorProps = $props();

	const engine = $derived(models[0].engine);
	const modelKind = $derived(PROVIDERS[engine].modelKind);

	/** Folder entry names the catalog cards above already represent. */
	const catalogNames = $derived(new Set(models.map(modelEntryName)));

	let entries = $state<LocalModelEntry[] | null>(null);

	const customEntries = $derived(
		(entries ?? []).filter((entry) => !catalogNames.has(entry.name)),
	);

	// The active selection vanished from the folder (deleted or renamed).
	const isSelectionMissing = $derived(
		!!value && entries !== null && !entries.some((e) => e.name === value),
	);

	async function refreshEntries() {
		if (!tauri) return;
		entries = await listModelEntries(engine);
	}

	// Rescan on mount, when the engine changes, and whenever the active model
	// changes (e.g. a catalog download just landed in the folder).
	$effect(() => {
		void engine;
		void value;
		refreshEntries();
	});

	async function openModelsFolder() {
		await tryAsync({
			try: async () => {
				const modelsDir = await PATHS.MODELS[engine]();
				await mkdir(modelsDir, { recursive: true });
				const { openPath } = await import('@tauri-apps/plugin-opener');
				await openPath(modelsDir);
			},
			catch: (error) => {
				toast.error('Failed to open models folder', {
					description: extractErrorMessage(error),
				});
				return Ok(undefined);
			},
		});
	}

	function activateEntry(entry: LocalModelEntry) {
		value = entry.name;
		toast.success('Model activated');
	}

	async function removeEntry(entry: LocalModelEntry) {
		const { error } = await deleteModelEntry({ engine, name: entry.name });
		if (error) {
			toast.error('Failed to delete model', {
				description: error.message,
			});
			return;
		}
		if (value === entry.name) value = '';
		await refreshEntries();
		toast.success('Model deleted');
	}
</script>

<svelte:window onfocus={refreshEntries} />

<Card.Root>
	<Card.Header>
		<Card.Title class="text-lg">{title}</Card.Title>
		<Card.Description>{description}</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-3">
		{#each models as model}
			<LocalModelDownloadCard {model} />
		{/each}

		{#each customEntries as entry (entry.name)}
			{@const isActive = value === entry.name}
			<div
				class="flex items-center gap-3 p-3 rounded-lg border {isActive
					? 'border-primary bg-primary/5'
					: ''}"
			>
				<div class="flex-1">
					<div class="flex items-center gap-2">
						<span class="font-medium">{entry.name}</span>
						{#if isActive}
							<Badge variant="default" class="text-xs">Active</Badge>
						{/if}
					</div>
					<div class="text-sm text-muted-foreground">
						{entry.isSymlink ? 'Your model (linked)' : 'Your model'}
					</div>
				</div>

				<div class="flex items-center gap-2">
					{#if isActive}
						<Button size="sm" variant="default" disabled>
							<CheckIcon class="size-4 mr-1" />
							Activated
						</Button>
					{:else}
						<Button
							size="sm"
							variant="outline"
							onclick={() => activateEntry(entry)}
						>
							Activate
						</Button>
					{/if}
					<Button size="sm" variant="ghost" onclick={() => removeEntry(entry)}>
						<X class="size-4" />
					</Button>
				</div>
			</div>
		{/each}

		{#if isSelectionMissing}
			<div class="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
				<p class="text-sm font-medium text-amber-600 dark:text-amber-400">
					Selected model is missing
				</p>
				<p class="mt-1 text-sm text-muted-foreground">
					"{value}" is no longer in the models folder. Download a model above
					or add yours back, then activate it.
				</p>
			</div>
		{/if}

		<div class="rounded-lg border bg-muted/50 p-4 space-y-3">
			<Field.Description>
				Have your own model? Put a model {modelKind === 'directory'
					? 'directory'
					: 'file (.bin, .gguf, or .ggml)'} in the models folder and it appears
				in this list. A symlink works too if you'd rather not keep a second
				copy.
			</Field.Description>
			<Button variant="outline" size="sm" onclick={openModelsFolder}>
				<FolderOpen class="size-4 mr-2" />
				Open Models Folder
			</Button>
			{#if footer}
				{@render footer()}
			{/if}
		</div>
	</Card.Content>
</Card.Root>
