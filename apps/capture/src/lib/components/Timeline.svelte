<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Field from '@epicenter/ui/field';
	import * as Item from '@epicenter/ui/item';
	import * as Modal from '@epicenter/ui/modal';
	import { Textarea } from '@epicenter/ui/textarea';
	import type { Captures } from '$lib/captures.svelte.js';

	let {
		captures,
		onOpen,
		onCreated,
		onRecover,
	}: {
		captures: Captures;
		onOpen: (stem: string) => void;
		onCreated: (stem: string) => void;
		onRecover: () => void;
	} = $props();

	const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

	let dialogOpen = $state(false);
	let createProblem = $state('');
	let creating = $state(false);
	/** The capture just added is opening: focus goes there, not back to the button. */
	let created = false;

	// The text lives in `captures`, so closing the dialog keeps it and leaving
	// the page asks first.
	async function addCapture(event: SubmitEvent) {
		event.preventDefault();
		if (creating) return;
		if (captures.newCapture.trim() === '') {
			createProblem = 'Write something first.';
			return;
		}
		creating = true;
		try {
			const result = await captures.create();
			if (!result.ok) {
				createProblem = `The save could not be confirmed: ${result.message} Your text is still here.`;
				return;
			}
			createProblem = '';
			created = true;
			dialogOpen = false;
			onCreated(result.stem);
		} finally {
			creating = false;
		}
	}
</script>

{#snippet newCaptureButton()}
	<Button aria-haspopup="dialog" onclick={() => (dialogOpen = true)}>
		New capture{captures.newCapture === '' ? '' : ' (draft)'}
	</Button>
{/snippet}

<div class="mb-4 flex min-h-9 items-center justify-between gap-4">
	<h1 class="text-lg font-semibold tracking-tight">Timeline</h1>
	<!-- The empty timeline holds this button itself. -->
	{#if captures.rows.length || !captures.loaded}{@render newCaptureButton()}{/if}
</div>

<Modal.Root bind:open={dialogOpen}>
	<Modal.Content
		class="md:max-w-xl"
		onCloseAutoFocus={(event) => {
			if (created) event.preventDefault();
		}}
	>
		<Modal.Header>
			<Modal.Title>New capture</Modal.Title>
			<Modal.Description>It is saved as a Markdown file, exactly as written.</Modal.Description>
		</Modal.Header>
		<form onsubmit={addCapture} class="flex flex-col gap-4 px-4 pb-4 md:p-0">
			<Field.Field>
				<Field.Label for="new-capture">Capture text</Field.Label>
				<Textarea
					id="new-capture"
					bind:value={captures.newCapture}
					oninput={() => (createProblem = '')}
					onkeydown={(event) => {
						if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}
					}}
					rows={6}
					aria-invalid={createProblem !== ''}
					class="max-h-64 min-h-32"
					placeholder="Write or paste something…"
				/>
				<Field.Description>Closing keeps this text until you add it or clear it. Ctrl or ⌘ + Enter adds it.</Field.Description>
				{#if createProblem}<Field.Error>{createProblem}</Field.Error>{/if}
			</Field.Field>
			<Modal.Footer class="flex-row justify-end gap-2 p-0">
				<Button type="button" variant="outline" onclick={() => (dialogOpen = false)}>Close</Button>
				<Button type="submit" disabled={creating}>{creating ? 'Saving…' : 'Add capture'}</Button>
			</Modal.Footer>
		</form>
	</Modal.Content>
</Modal.Root>

{#if captures.rows.length}
	<Item.Group aria-label="Timeline captures" class="gap-1">
		{#each captures.rows as row (row.path)}
			<Item.Button size="sm" class="w-full text-left hover:bg-muted" onclick={() => onOpen(row.stem)}>
				<Item.Content>
					<Item.Title class={['line-clamp-2 whitespace-pre-line break-words', !row.preview && 'text-muted-foreground']}>{row.preview || 'Empty capture'}</Item.Title>
					<Item.Description class="text-xs">
						{#if row.capturedAt}
							<time datetime={row.capturedAt.toISOString()}>{when.format(row.capturedAt)}</time>
						{:else}
							No capture date
						{/if}
						{#if row.thoughtCount > 0} · {row.thoughtCount} {row.thoughtCount === 1 ? 'thought' : 'thoughts'}{/if}
					</Item.Description>
				</Item.Content>
				{#if row.conflict === 'removed'}<Badge variant="destructive">File removed, draft kept</Badge>
				{:else if row.conflict === 'unreadable'}<Badge variant="destructive">Cannot be read</Badge>
				{:else if row.conflict === 'present'}<Badge variant="destructive">Changed elsewhere</Badge>
				{:else if row.unsettled}<Badge variant="outline">Not saved</Badge>{/if}
				{#if row.problem}<Badge variant="destructive">Needs repair</Badge>{/if}
			</Item.Button>
		{/each}
	</Item.Group>
{:else if captures.loaded}
	<Empty.Root>
		<Empty.Header>
			<Empty.Title>No captures yet</Empty.Title>
			<Empty.Description>Write or paste something to keep. Each capture is one Markdown file, and you can add thoughts to it later.</Empty.Description>
		</Empty.Header>
		<Empty.Content>{@render newCaptureButton()}</Empty.Content>
	</Empty.Root>
{/if}

{#if captures.unreadable.length}
	<Alert.Root variant="destructive" aria-label="Unreadable files" class="mt-6">
		<Alert.Title>{captures.unreadable.length} {captures.unreadable.length === 1 ? 'file' : 'files'} could not be read</Alert.Title>
		<Alert.Description>They are still in the folder, untouched.</Alert.Description>
		<ul class="mt-1 list-disc pl-5 text-foreground">
			{#each captures.unreadable as file (file.path)}
				<li class="break-words"><code>{file.path}</code>: {file.message}</li>
			{/each}
		</ul>
	</Alert.Root>
{/if}

<footer class="mt-10 border-t pt-4 text-xs text-muted-foreground">
	<p>
		{#if captures.location.kind === 'directory'}
			Files are in <code>captures</code> under <code class="break-all">{captures.location.root}</code>.
		{:else}
			Files are kept in this browser.
		{/if}
	</p>
	<Button variant="link" size="xs" class="h-auto p-0 whitespace-normal text-left" onclick={onRecover}>Bring in captures from before this version…</Button>
</footer>
