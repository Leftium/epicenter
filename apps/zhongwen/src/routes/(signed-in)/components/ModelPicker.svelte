<script lang="ts">
	import * as Select from '@epicenter/ui/select';
	import { PROVIDER_MODELS, type Provider } from '../chat/providers';

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
		provider: string;
		model: string;
		onProviderChange: (provider: string) => void;
		onModelChange: (model: string) => void;
	} = $props();

	const providers = Object.keys(PROVIDER_MODELS) as Provider[];
	const models = $derived(PROVIDER_MODELS[provider as Provider]);
</script>

<div class="flex items-center gap-1.5">
	<Select.Root
		type="single"
		value={provider}
		onValueChange={(value) => {
			if (value) onProviderChange(value);
		}}
	>
		<Select.Trigger size="sm">{provider}</Select.Trigger>
		<Select.Content>
			{#each providers as p (p)}
				<Select.Item value={p} label={p} />
			{/each}
		</Select.Content>
	</Select.Root>

	<span class="text-sm text-muted-foreground">/</span>

	<Select.Root
		type="single"
		value={model}
		onValueChange={(value) => {
			if (value) onModelChange(value);
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
