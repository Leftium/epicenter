<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Link } from '@epicenter/ui/link';
	import { settings } from '$lib/stores/settings.svelte';

	// Local state for text inputs to avoid saving on every keystroke
	let apiKey = $state(settings.value['apiKeys.openrouter']);
</script>

<Field.Field>
	<Field.Label for="openrouter-api-key">OpenRouter API Key</Field.Label>
	<Input
		id="openrouter-api-key"
		type="password"
		placeholder="Your OpenRouter API Key"
		autocomplete="off"
		bind:value={apiKey}
		onchange={() => settings.updateKey('apiKeys.openrouter', apiKey)}
	/>
	<Field.Description>
		You can find your OpenRouter API key in your <Link
			href="https://openrouter.ai/keys"
			target="_blank"
			rel="noopener noreferrer"
		>
			OpenRouter dashboard
		</Link>.
	</Field.Description>
</Field.Field>
