<script lang="ts">
	/**
	 * The shared, model-first inference picker (ADR-0059). One flat searchable list
	 * of models grouped by connection: the hosted Epicenter catalog plus each
	 * device-local custom connection's discovered models, with "Connect a
	 * provider..." as the footer escape hatch. The model is the only leaf; the
	 * connection (billing / location) is a group facet, never a level.
	 *
	 * The device's connections, discovery, and resolution all live in the injected
	 * {@link InferenceConnections} registry, so this component is just UI: it reads
	 * the registry and calls its methods. Mounted like `<AccountPopover />`: once per
	 * chat surface, bound to that app's registry.
	 */
	import { CONNECTION_PRESETS, type PresetId } from '@epicenter/client';
	import { Button } from '@epicenter/ui/button';
	import * as Command from '@epicenter/ui/command';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import * as Popover from '@epicenter/ui/popover';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Check from '@lucide/svelte/icons/check';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import Cloud from '@lucide/svelte/icons/cloud';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import HardDrive from '@lucide/svelte/icons/hard-drive';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import type {
		CustomConnection,
		InferenceConnections,
	} from './connections.svelte.js';

	type Props = {
		/** The conversation's current model id (synced, ADR-0055). */
		model: string;
		/** Commit a model pick. Writes the synced conversation model column. */
		onSelectModel: (model: string) => void;
		/** The device's inference connection registry (hosted catalog + custom set). */
		connections: InferenceConnections;
		/** Disable while a turn generates, so a transcript never spans backends. */
		disabled?: boolean;
	};

	let { model, onSelectModel, connections, disabled = false }: Props = $props();

	let open = $state(false);
	let view = $state<'list' | 'connect'>('list');

	// "Connect a provider" form state. `formPreset` null means the preset chooser
	// is showing; a value means its sub-form is.
	let formPreset = $state<PresetId | 'custom' | null>(null);
	let formBaseUrl = $state('');
	let formApiKey = $state('');
	let formModel = $state('');
	let showKey = $state(false);

	// Discovery state for the connect form.
	let discovering = $state(false);
	let discovered = $state<string[] | null>(null);
	let discoveryFailed = $state(false);

	function isLocal(baseUrl: string): boolean {
		return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(baseUrl);
	}

	function connectionLabel(connection: CustomConnection): string {
		if (connection.preset)
			return (
				CONNECTION_PRESETS.find((p) => p.id === connection.preset)?.label ??
				connection.preset
			);
		try {
			return new URL(connection.baseUrl).host;
		} catch {
			return connection.baseUrl;
		}
	}

	const requiresKey = $derived(
		formPreset === 'custom' ||
			(formPreset !== null &&
				(CONNECTION_PRESETS.find((p) => p.id === formPreset)?.requiresKey ??
					false)),
	);

	// The label on the closed trigger: a hosted model shows its product role
	// (Fast, Best); a custom model shows its raw id (Ollama ids have no nice name).
	const triggerLabel = $derived(
		connections.hostedModels.find((m) => m.id === model)?.label ??
			model ??
			'Select model',
	);

	function selectModel(id: string) {
		onSelectModel(id);
		open = false;
	}

	function choosePreset(id: PresetId | 'custom') {
		formPreset = id;
		formApiKey = '';
		formModel = '';
		discovered = null;
		discoveryFailed = false;
		formBaseUrl =
			id === 'custom'
				? ''
				: (CONNECTION_PRESETS.find((p) => p.id === id)?.baseUrl ?? '');
	}

	// Save the connection being configured (caching its discovered models), select
	// the chosen model, and close: one commit for the whole "connect and use" path.
	function commitConnection(chosenModel: string) {
		const baseUrl = formBaseUrl.trim();
		const trimmedModel = chosenModel.trim();
		if (!baseUrl || !trimmedModel) return;
		connections.add(
			{
				kind: 'custom',
				preset: formPreset && formPreset !== 'custom' ? formPreset : undefined,
				baseUrl,
				apiKey: formApiKey.trim() || undefined,
			},
			discovered ?? undefined,
		);
		onSelectModel(trimmedModel);
		open = false;
	}

	// Reopening the picker always lands on the model list, never a half-filled form.
	$effect(() => {
		if (!open) view = 'list';
	});

	// Auto-discover on a debounced change of the connect form's endpoint or key.
	// Best effort: a failure degrades to the free-text model floor, never a toast.
	$effect(() => {
		if (view !== 'connect') return;
		const url = formBaseUrl.trim();
		const key = formApiKey.trim();
		if (!url) {
			discovered = null;
			discoveryFailed = false;
			discovering = false;
			return;
		}
		let cancelled = false;
		discovering = true;
		discoveryFailed = false;
		const handle = setTimeout(async () => {
			const { data, error } = await connections.discover(url, key || undefined);
			if (cancelled) return;
			discovering = false;
			if (error) {
				discovered = null;
				discoveryFailed = true;
				return;
			}
			discovered = data;
		}, 500);
		return () => {
			cancelled = true;
			clearTimeout(handle);
		};
	});
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				{disabled}
				variant="outline"
				size="sm"
				role="combobox"
				aria-expanded={open}
				class="max-w-56 justify-between gap-2 font-normal"
			>
				<span class="truncate">{triggerLabel}</span>
				<ChevronsUpDown class="size-4 shrink-0 opacity-50" />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-80 p-0" align="end">
		{#if view === 'list'}
			<Command.Root>
				<Command.Input placeholder="Search models..." />
				<Command.List class="max-h-80">
					<Command.Empty>No models found.</Command.Empty>

					{#if connections.hostedModels.length > 0}
						<Command.Group heading="Epicenter · metered">
							{#each connections.hostedModels as hostedModel (hostedModel.id)}
								<Command.Item
									value={`${hostedModel.label} ${hostedModel.id}`}
									keywords={[hostedModel.id, hostedModel.label]}
									onSelect={() => selectModel(hostedModel.id)}
								>
									<Check
										class="size-4 shrink-0 {model === hostedModel.id
											? 'opacity-100'
											: 'opacity-0'}"
									/>
									<span class="flex-1 truncate">{hostedModel.label}</span>
									<span class="text-xs text-muted-foreground">
										{hostedModel.credits} cr
									</span>
								</Command.Item>
							{/each}
						</Command.Group>
					{/if}

					{#each connections.custom as connection (connection.baseUrl)}
						{@const ids = connections.discoveredModels[connection.baseUrl] ?? []}
						<Command.Group
							heading="{connectionLabel(connection)} · {isLocal(
								connection.baseUrl,
							)
								? 'local'
								: 'cloud'}"
						>
							{#each ids as id (id)}
								<Command.Item
									value="{id} {connectionLabel(connection)}"
									keywords={[id]}
									onSelect={() => selectModel(id)}
								>
									<Check
										class="size-4 shrink-0 {model === id
											? 'opacity-100'
											: 'opacity-0'}"
									/>
									{#if isLocal(connection.baseUrl)}
										<HardDrive class="size-4" />
									{:else}
										<Cloud class="size-4" />
									{/if}
									<span class="flex-1 truncate">{id}</span>
								</Command.Item>
							{:else}
								<Command.Item disabled value="{connection.baseUrl} empty">
									<span class="text-xs text-muted-foreground">
										No models discovered
									</span>
								</Command.Item>
							{/each}
							<Command.Item
								value="remove {connection.baseUrl}"
								onSelect={() => connections.remove(connection.baseUrl)}
							>
								<Trash2 class="size-4" />
								<span class="text-xs">Remove {connectionLabel(connection)}</span>
							</Command.Item>
						</Command.Group>
					{/each}

					<Command.Separator />
					<Command.Item
						value="connect a provider"
						onSelect={() => (view = 'connect')}
					>
						<Plus class="size-4" />
						<span>Connect a provider...</span>
					</Command.Item>
				</Command.List>
			</Command.Root>
		{:else}
			<div class="space-y-3 p-3">
				<div class="flex items-center gap-2">
					<Button
						variant="ghost"
						size="icon-sm"
						onclick={() => (view = 'list')}
						aria-label="Back to models"
					>
						<ArrowLeft class="size-4" />
					</Button>
					<p class="text-sm font-medium">Connect a provider</p>
				</div>

				{#if formPreset === null}
					<div class="space-y-1">
						{#each CONNECTION_PRESETS as preset (preset.id)}
							<Button
								variant="outline"
								size="sm"
								class="w-full justify-between"
								onclick={() => choosePreset(preset.id)}
							>
								<span>{preset.label}</span>
								<span class="text-xs text-muted-foreground">
									{isLocal(preset.baseUrl) ? 'local' : 'cloud'}
								</span>
							</Button>
						{/each}
						<Button
							variant="outline"
							size="sm"
							class="w-full justify-start"
							onclick={() => choosePreset('custom')}
						>
							Custom URL
						</Button>
					</div>
				{:else}
					<div class="space-y-1">
						<Label for="conn-url" class="text-xs">Base URL</Label>
						<Input
							id="conn-url"
							bind:value={formBaseUrl}
							placeholder="http://localhost:11434/v1"
						/>
					</div>

					{#if requiresKey}
						<div class="space-y-1">
							<Label for="conn-key" class="text-xs">
								API key{formPreset === 'custom' ? ' (optional)' : ''}
							</Label>
							<div class="flex gap-1">
								<Input
									id="conn-key"
									type={showKey ? 'text' : 'password'}
									bind:value={formApiKey}
									placeholder="sk-..."
								/>
								<Button
									variant="ghost"
									size="icon-sm"
									onclick={() => (showKey = !showKey)}
									aria-label={showKey ? 'Hide key' : 'Show key'}
								>
									{#if showKey}
										<EyeOff class="size-4" />
									{:else}
										<Eye class="size-4" />
									{/if}
								</Button>
							</div>
						</div>
					{/if}

					<div class="space-y-1">
						<Label class="text-xs">Model</Label>
						{#if discovering}
							<p class="flex items-center gap-2 text-xs text-muted-foreground">
								<LoaderCircle class="size-3.5 animate-spin" /> Loading models...
							</p>
						{:else if discovered && discovered.length > 0}
							<Command.Root class="rounded-md border">
								<Command.Input placeholder="Search models..." />
								<Command.List class="max-h-48">
									<Command.Empty>No models found.</Command.Empty>
									{#each discovered as id (id)}
										<Command.Item
											value={id}
											keywords={[id]}
											onSelect={() => commitConnection(id)}
										>
											<span class="truncate">{id}</span>
										</Command.Item>
									{/each}
								</Command.List>
							</Command.Root>
						{:else}
							{#if discoveryFailed}
								<p class="text-xs text-muted-foreground">
									Couldn't list models, type one manually.
								</p>
							{:else if formBaseUrl.trim()}
								<p class="text-xs text-muted-foreground">
									No models found at this endpoint, type one manually.
								</p>
							{:else}
								<p class="text-xs text-muted-foreground">
									Enter an endpoint to load models.
								</p>
							{/if}
							<div class="flex gap-1">
								<Input bind:value={formModel} placeholder="qwen2.5:3b" />
								<Button
									size="sm"
									disabled={!formBaseUrl.trim() || !formModel.trim()}
									onclick={() => commitConnection(formModel)}
								>
									Add
								</Button>
							</div>
						{/if}
					</div>

					<p class="text-xs text-muted-foreground">
						Requests go straight to this URL. Your Epicenter sign-in is never
						sent there.
					</p>
				{/if}
			</div>
		{/if}
	</Popover.Content>
</Popover.Root>
