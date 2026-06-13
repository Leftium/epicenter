<script lang="ts">
	import {
		SERVABLE_PROVIDER_MODELS,
		SERVABLE_PROVIDERS,
		type ServableModel,
		type ServableProvider,
	} from '@epicenter/constants/ai-providers';
	import * as Select from '@epicenter/ui/select';

	// Provider/model are durable conversation-row fields, not runtime state, so
	// this picker reads/writes them directly and stays mountable in the header
	// independent of whether a generation is in flight. Changing the model
	// mid-generation is harmless: the server snapshots the prompt at kickoff, so
	// the new choice simply applies to the next turn.
	let {
		provider,
		model,
		onProviderChange,
		onModelChange,
	}: {
		provider: ServableProvider;
		model: ServableModel;
		onProviderChange: (provider: ServableProvider) => void;
		onModelChange: (model: ServableModel) => void;
	} = $props();

	const models = $derived(SERVABLE_PROVIDER_MODELS[provider]);
</script>

<div class="flex items-center gap-1.5">
	<Select.Root
		type="single"
		value={provider}
		onValueChange={(value) => {
			if (value && value in SERVABLE_PROVIDER_MODELS) {
				onProviderChange(value as ServableProvider);
			}
		}}
	>
		<Select.Trigger size="sm">{provider}</Select.Trigger>
		<Select.Content>
			{#each SERVABLE_PROVIDERS as providerOption (providerOption)}
				<Select.Item value={providerOption} label={providerOption} />
			{/each}
		</Select.Content>
	</Select.Root>

	<span class="text-sm text-muted-foreground">/</span>

	<Select.Root
		type="single"
		value={model}
		onValueChange={(value) => {
			if (value && models.some((model) => model === value)) {
				onModelChange(value as ServableModel);
			}
		}}
	>
		<Select.Trigger size="sm">{model}</Select.Trigger>
		<Select.Content>
			{#each models as m (m)}
				<Select.Item value={m} label={m} />
			{/each}
		</Select.Content>
	</Select.Root>
</div>
