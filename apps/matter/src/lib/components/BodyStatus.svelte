<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import type { BodyEditor } from '$lib/table.svelte';

	// Where one file's accepted body stands, with the commands each state offers.
	// The row dialog shows it under the editor; the table pane shows it for bodies
	// needing attention, including files the dialog can no longer open.
	let { editor }: { editor: BodyEditor } = $props();

	const status = $derived(editor.status);
</script>

{#if status.kind === 'failed'}
	<Alert.Root variant="destructive">
		<Alert.Title>Couldn't save the body of {editor.fileName}</Alert.Title>
		<Alert.Description class="grid gap-2">
			<p>{status.reason}</p>
			<p>Matter keeps your text while this vault stays open, until you discard it.</p>
			<div class="flex flex-wrap gap-2">
				<Button size="sm" onclick={() => editor.retry()}>Try again</Button>
				<Button size="sm" variant="outline" onclick={() => editor.discard()}>
					Discard my text
				</Button>
			</div>
		</Alert.Description>
	</Alert.Root>
{:else}
	<p class="flex min-h-6 items-center gap-2 text-xs text-muted-foreground">
		{#if status.kind === 'saving'}
			Saving…
			{#if status.reason}<span>Previous save failed: {status.reason}</span>{/if}
		{:else if status.kind === 'changed'}
			The observed file body differs. Your next edit replaces it.
			<Button size="xs" variant="outline" onclick={() => editor.discard()}>
				Discard my text
			</Button>
		{/if}
	</p>
{/if}
