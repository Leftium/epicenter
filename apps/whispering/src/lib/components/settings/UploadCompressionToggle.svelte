<script lang="ts">
	import { Checkbox } from '@epicenter/ui/checkbox';
	import * as Field from '@epicenter/ui/field';
	import { settings } from '$lib/state/settings.svelte';

	const isTauri = $derived(Boolean(window.__TAURI_INTERNALS__));
	const isEnabled = $derived(
		settings.get('transcription.uploadCompression') === 'opus',
	);
</script>

<Field.Field orientation="horizontal">
	<Checkbox
		id="upload-compression"
		checked={isEnabled}
		disabled={!isTauri}
		onCheckedChange={(checked) =>
			settings.set(
				'transcription.uploadCompression',
				checked === true ? 'opus' : 'wav',
			)}
	/>
	<Field.Content>
		<Field.Label for="upload-compression">
			Compress cloud uploads with Opus
		</Field.Label>
		<Field.Description>
			{#if isTauri}
				Encode WAV recordings as 24 kbps Opus before sending to cloud transcription
				providers. Cuts upload size roughly 20× with no perceptible quality loss
				for speech.
			{:else}
				The Opus encoder runs natively and is only available in the desktop app.
				Browser recordings already upload as compressed audio.
			{/if}
		</Field.Description>
	</Field.Content>
</Field.Field>
