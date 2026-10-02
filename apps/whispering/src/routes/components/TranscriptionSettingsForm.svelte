<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import { getSession } from '$lib/session.svelte.js';

	/**
	 * The transcription settings form: the endpoint and model are folder
	 * settings in kv.json; the key stays on this device. It edits the session's
	 * one draft, so the header's Settings and the control beside the recorder
	 * show the same typing and share one save. Saving sends nothing to the
	 * endpoint and asks it nothing: the model is whatever the person types.
	 */
	const { library, settings } = getSession();
	const credential = $derived(library.workspace.credential);

	async function save(event: SubmitEvent) {
		event.preventDefault();
		const problem = await settings.save();
		if (problem) toast.error(problem.title, { description: problem.description });
		else toast.success('Settings saved');
	}
</script>

<form class="flex flex-col gap-3 text-sm" onsubmit={save}>
	<p class="font-medium">Transcription</p>
	<label class="flex flex-col gap-1">
		<span class="text-xs text-muted-foreground">Model</span>
		<Input bind:value={settings.model} autocomplete="off" spellcheck={false} data-testid="settings-model" />
		<span class="text-xs text-muted-foreground">The name your endpoint uses for it.</span>
	</label>
	<label class="flex flex-col gap-1">
		<span class="text-xs text-muted-foreground">Endpoint (OpenAI-compatible base URL)</span>
		<Input bind:value={settings.baseUrl} autocomplete="off" spellcheck={false} data-testid="settings-base-url" />
	</label>
	<label class="flex flex-col gap-1">
		<span class="text-xs text-muted-foreground">
			API key ({library.credentialPresent ? 'one is set' : 'none set'})
		</span>
		<Input
			type="password"
			bind:value={settings.apiKey}
			placeholder={library.credentialPresent ? 'Leave empty to keep the current key' : 'Optional for a local endpoint'}
			autocomplete="off"
			disabled={credential.readOnlyReason !== undefined}
			data-testid="settings-api-key"
		/>
	</label>
	<p class="text-xs text-muted-foreground">
		{credential.readOnlyReason ?? `Kept in ${credential.storedIn}.`}
		Transformations use the same key.
	</p>
	{#if library.settingsProblem}
		<p class="text-xs text-destructive" role="alert">kv.json: {library.settingsProblem}</p>
	{/if}
	<Button type="submit" size="sm" disabled={settings.saving} data-testid="settings-save">
		{#if settings.saving}<Spinner class="size-3.5" />{/if}
		Save settings
	</Button>
</form>
