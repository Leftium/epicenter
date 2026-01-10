<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Link } from '@epicenter/ui/link';
	import { settings } from '$lib/stores/settings.svelte';

	// Local state for text inputs to avoid saving on every keystroke
	let apiKey = $state(settings.value['apiKeys.mistral']);
</script>

<Field.Field>
	<Field.Label for="mistral-api-key">Mistral AI API Key</Field.Label>
	<Input
		id="mistral-api-key"
		type="password"
		placeholder="Your Mistral AI API Key"
		autocomplete="off"
		bind:value={apiKey}
		onchange={() => settings.updateKey('apiKeys.mistral', apiKey)}
	/>
	<Field.Description>
		You can find your API key in your <Link
			href="https://console.mistral.ai/api-keys/"
			target="_blank"
			rel="noopener noreferrer"
		>
			Mistral console
		</Link>. Voxtral transcription is priced at <Link
			href="https://mistral.ai/pricing#api-pricing"
			target="_blank"
			rel="noopener noreferrer"
		>
			$0.12/hour
		</Link>
		of audio.
	</Field.Description>
</Field.Field>
