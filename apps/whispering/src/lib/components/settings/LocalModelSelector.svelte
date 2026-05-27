<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import * as Tabs from '@epicenter/ui/tabs';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import X from '@lucide/svelte/icons/x';
	import { basename, join } from '@tauri-apps/api/path';
	import { open } from '@tauri-apps/plugin-dialog';
	import { copyFile, mkdir, readDir } from '@tauri-apps/plugin-fs';
	import type { Snippet } from 'svelte';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { Ok, tryAsync } from 'wellcrafted/result';
	import type { LocalModelConfig } from '$lib/constants/local-models';
	import { PATHS } from '$lib/constants/paths';
	import { tauri } from '$lib/tauri';
	import LocalModelDownloadCard from './LocalModelDownloadCard.svelte';

	/**
	 * Props for the LocalModelSelector component
	 */
	type LocalModelSelectorProps = {
		/** Array of pre-built models available for download */
		models: readonly LocalModelConfig[];

		/** Component title displayed in the card header */
		title: string;

		/** Component description displayed below the title */
		description: string;

		/** Whether to select files or directories */
		fileSelectionMode: 'file' | 'directory';

		/** File extensions to filter (for file mode only) */
		fileExtensions?: string[];

		/** Bindable value with getter/setter for the model path */
		value: string;

		/** Optional footer content for pre-built models tab */
		prebuiltFooter?: Snippet;

		/** Custom instructions for manual selection tab */
		manualInstructions?: Snippet;
	};

	let {
		models,
		title,
		description,
		fileSelectionMode,
		fileExtensions = [],
		value = $bindable(),
		prebuiltFooter,
		manualInstructions,
	}: LocalModelSelectorProps = $props();

	// Extract the model name from the current path
	const modelName = $derived.by(async () => {
		const path = value;
		if (!path) return '';
		return await basename(path);
	});

	// Check if current model is pre-built
	const prebuiltModelInfo = $derived(
		models.find((m) => {
			if (!value) return false;
			switch (m.engine) {
				case 'whispercpp':
					return value.endsWith(m.file.filename);
				case 'parakeet':
				case 'moonshine':
					return value.endsWith(m.directoryName);
			}
		}) ?? null,
	);
	const isPrebuiltModel = $derived(!!prebuiltModelInfo);

	async function getModelRoot() {
		const engine = models[0]?.engine;
		switch (engine) {
			case 'whispercpp':
				return PATHS.MODELS.WHISPER();
			case 'parakeet':
				return PATHS.MODELS.PARAKEET();
			case 'moonshine':
				return PATHS.MODELS.MOONSHINE();
			default:
				throw new Error('No local model engine configured');
		}
	}

	async function copyDirectory(sourceDir: string, destinationDir: string) {
		await mkdir(destinationDir, { recursive: true });
		const entries = await readDir(sourceDir);

		for (const entry of entries) {
			const sourcePath = await join(sourceDir, entry.name);
			const destinationPath = await join(destinationDir, entry.name);

			if (entry.isDirectory) {
				await copyDirectory(sourcePath, destinationPath);
			} else if (entry.isFile) {
				await copyFile(sourcePath, destinationPath);
			} else {
				throw new Error('Selected model directory cannot include symlinks');
			}
		}
	}

	/**
	 * Open file/folder browser for manual model selection
	 */
	async function selectModel() {
		if (!tauri) return;

		await tryAsync({
			try: async () => {
				const modelRoot = await getModelRoot();
				await mkdir(modelRoot, { recursive: true });

				if (fileSelectionMode === 'directory') {
					const selected = await open({
						directory: true,
						multiple: false,
						title: `Select ${title} Directory`,
					});

					if (selected) {
						const entries = await readDir(selected);
						if (entries.length === 0) {
							throw new Error('Selected directory appears to be empty');
						}
						const directoryName = await basename(selected);
						const importedPath = await join(modelRoot, directoryName);
						await copyDirectory(selected, importedPath);
						value = importedPath;
						toast.success('Model directory imported');
					}
				} else {
					const filters =
						fileExtensions.length > 0
							? [
									{
										name: `${title} Files`,
										extensions: fileExtensions,
									},
								]
							: [];

					const selected = await open({
						multiple: false,
						filters,
						title: `Select ${title} File`,
					});

					if (selected) {
						const fileName = await basename(selected);
						const importedPath = await join(modelRoot, fileName);
						await copyFile(selected, importedPath);
						value = importedPath;
						toast.success('Model file imported');
					}
				}
			},
			catch: (error) => {
				toast.error('Failed to select model', {
					description: extractErrorMessage(error),
				});
				return Ok(undefined);
			},
		});
	}

	/**
	 * Clear the currently selected model
	 */
	function clearModel() {
		value = '';
		toast.success('Model path cleared');
	}
</script>

<Card.Root>
	<Card.Header>
		<Card.Title class="text-lg">{title}</Card.Title>
		<Card.Description>{description}</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-6">
		<Tabs.Root value="prebuilt" class="w-full">
			<Tabs.List class="grid w-full grid-cols-2">
				<Tabs.Trigger value="prebuilt">Pre-built Models</Tabs.Trigger>
				<Tabs.Trigger value="manual">Manual Selection</Tabs.Trigger>
			</Tabs.List>

			<!-- Pre-built Models Tab -->
			<Tabs.Content value="prebuilt" class="mt-4 space-y-3">
				{#each models as model}
					<LocalModelDownloadCard {model} />
				{/each}

				{#if prebuiltFooter}
					<div class="rounded-lg border bg-muted/50 p-4">
						{@render prebuiltFooter()}
					</div>
				{/if}
			</Tabs.Content>

			<!-- Manual Selection Tab -->
			<Tabs.Content value="manual" class="mt-4 space-y-4">
				{#if manualInstructions}
					{@render manualInstructions()}
				{/if}

				<!-- Model Selection Input -->
				<div>
					<p class="text-sm font-medium mb-2">
						{#if manualInstructions}
							<span class="text-muted-foreground">Step 2:</span>
							Select the model
							{fileSelectionMode === 'directory' ? 'directory' : 'file'}
						{:else}
							Select the model
							{fileSelectionMode === 'directory' ? 'directory' : 'file'}
						{/if}
					</p>
					<div class="flex items-center gap-2">
						<Input
							type="text"
							{value}
							readonly
							placeholder="No model selected"
							class="flex-1"
						/>
						{#if value}
							<Button
								variant="outline"
								size="icon"
								onclick={clearModel}
								title="Clear model path"
							>
								<X class="size-4" />
							</Button>
						{/if}
						<Button
							variant="outline"
							size="icon"
							onclick={selectModel}
							title={fileSelectionMode === 'directory'
								? 'Browse for model directory'
								: 'Browse for model file'}
						>
							{#if fileSelectionMode === 'directory'}
								<FolderOpen class="size-4" />
							{:else}
								<Paperclip class="size-4" />
							{/if}
						</Button>
					</div>

					<!-- Display selected model info -->
					{#if value}
						<div class="mt-2 space-y-1">
							{#await modelName then name}
								{#if name}
									<p class="text-sm text-muted-foreground">
										<span class="font-medium">Selected:</span>
										{name}
									</p>
								{/if}
							{/await}

							{#if isPrebuiltModel && prebuiltModelInfo}
								<p class="text-sm text-muted-foreground">
									<span class="font-medium">Size:</span>
									{prebuiltModelInfo.size}
									{#if fileSelectionMode === 'directory'}
										(directory with model files)
									{/if}
								</p>
							{/if}
						</div>
					{/if}
				</div>
			</Tabs.Content>
		</Tabs.Root>
	</Card.Content>
</Card.Root>
