<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Link } from '@epicenter/ui/link';
	import { settings } from '$lib/stores/settings.svelte';

	// Local state for text inputs to avoid saving on every keystroke
	let apiKey = $state(settings.value['apiKeys.elevenlabs']);
</script>

<Field.Field>
	<Field.Label for="elevenlabs-api-key">ElevenLabs API Key</Field.Label>
	<Input
		id="elevenlabs-api-key"
		type="password"
		placeholder="Your ElevenLabs API Key"
		autocomplete="off"
		bind:value={apiKey}
		onchange={() => settings.updateKey('apiKeys.elevenlabs', apiKey)}
	/>
	<Field.Description>
		You can find your ElevenLabs API key in your <Link
			href="https://elevenlabs.io/app/settings/api-keys"
			target="_blank"
			rel="noopener noreferrer"
		>
			ElevenLabs console
		</Link>.
	</Field.Description>
</Field.Field>
