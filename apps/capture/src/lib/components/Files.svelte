<!--
	Every capture file, by path, whether or not it reads as a capture. Opening
	one shows its complete text. Files that could not be read are named with
	why, and have no text to open.
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Badge } from '@epicenter/ui/badge';
	import * as Empty from '@epicenter/ui/empty';
	import * as Item from '@epicenter/ui/item';
	import type { Captures } from '$lib/captures.svelte.js';

	let {
		captures,
		onOpen,
	}: {
		captures: Captures;
		onOpen: (stem: string) => void;
	} = $props();
</script>

<div class="mb-4 flex min-h-9 items-center">
	<h1 class="text-lg font-semibold tracking-tight">Files</h1>
</div>

{#if captures.files.length}
	<Item.Group aria-label="Capture files" class="gap-1">
		{#each captures.files as row (row.path)}
			<Item.Button size="sm" class="w-full text-left hover:bg-muted" onclick={() => onOpen(row.stem)}>
				<Item.Content>
					<Item.Title class="break-all font-mono text-sm">{row.path}</Item.Title>
					{#if row.problem}<Item.Description class="text-xs break-words">{row.problem}</Item.Description>{/if}
				</Item.Content>
				{#if row.attention === 'removed'}<Badge variant="destructive">File removed</Badge>
				{:else if row.attention === 'failed'}<Badge variant="destructive">Save failed</Badge>
				{:else if row.attention === 'unconfirmed'}<Badge variant="destructive">Save not confirmed</Badge>
				{:else if row.attention === 'deletion'}<Badge variant="destructive">Delete not confirmed</Badge>
				{:else if row.unsettled}<Badge variant="outline">Not saved</Badge>{/if}
				{#if row.problem}<Badge variant="destructive">Needs repair</Badge>{/if}
			</Item.Button>
		{/each}
	</Item.Group>
{:else if captures.loaded && !captures.unreadable.length}
	<Empty.Root>
		<Empty.Header>
			<Empty.Title>No capture files</Empty.Title>
			<Empty.Description>Each capture is one Markdown file in <code>captures</code>.</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{/if}

{#if captures.unreadable.length}
	<Alert.Root variant="destructive" aria-label="Unreadable files" class="mt-6">
		<Alert.Title>{captures.unreadable.length} {captures.unreadable.length === 1 ? 'file' : 'files'} could not be read</Alert.Title>
		<Alert.Description>They are still in the folder, untouched. Repair them with another program, then return to this window.</Alert.Description>
		<ul class="mt-1 list-disc pl-5 text-foreground">
			{#each captures.unreadable as file (file.path)}
				<li class="break-words"><code>{file.path}</code>: {file.message}</li>
			{/each}
		</ul>
	</Alert.Root>
{/if}
