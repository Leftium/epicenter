<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { settings } from '$lib/stores/settings.svelte';

	type Props = {
		showBaseUrl?: boolean;
	};

	let { showBaseUrl = true }: Props = $props();

	// Local state for text inputs to avoid saving on every keystroke
	let baseUrl = $state(settings.value['completion.custom.baseUrl']);
	let apiKey = $state(settings.value['apiKeys.custom']);
</script>

<div class="space-y-4">
	{#if showBaseUrl}
		<Field.Field>
			<Field.Label for="custom-endpoint-base-url"
				>Custom API Base URL</Field.Label
			>
			<Input
				id="custom-endpoint-base-url"
				placeholder="e.g. http://localhost:11434/v1"
				autocomplete="off"
				bind:value={baseUrl}
				onchange={() =>
					settings.updateKey('completion.custom.baseUrl', baseUrl)}
			/>
			<Field.Description>
				Global default URL for OpenAI-compatible endpoints (Ollama, LM Studio,
				llama.cpp, etc.). Can be overridden per-step in transformations.
			</Field.Description>
		</Field.Field>
	{/if}

	<Field.Field>
		<Field.Label for="custom-endpoint-api-key">Custom API Key</Field.Label>
		<Input
			id="custom-endpoint-api-key"
			type="password"
			placeholder="Leave empty if not required"
			autocomplete="off"
			bind:value={apiKey}
			onchange={() => settings.updateKey('apiKeys.custom', apiKey)}
		/>
		<Field.Description>
			Most local endpoints don't require authentication. Only enter a key if
			your endpoint requires it.
		</Field.Description>
	</Field.Field>
</div>
