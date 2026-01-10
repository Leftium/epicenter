<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Link } from '@epicenter/ui/link';
	import { settings } from '$lib/stores/settings.svelte';

	// Local state for text inputs to avoid saving on every keystroke
	let apiKey = $state(settings.value['apiKeys.anthropic']);
</script>

<Field.Field>
	<Field.Label for="anthropic-api-key">Anthropic API Key</Field.Label>
	<Input
		id="anthropic-api-key"
		type="password"
		placeholder="Your Anthropic API Key"
		autocomplete="off"
		bind:value={apiKey}
		onchange={() => settings.updateKey('apiKeys.anthropic', apiKey)}
	/>
	<Field.Description>
		You can find your Anthropic API key in your <Link
			href="https://console.anthropic.com/settings/keys"
			target="_blank"
			rel="noopener noreferrer"
		>
			Anthropic console
		</Link>.
	</Field.Description>
</Field.Field>
