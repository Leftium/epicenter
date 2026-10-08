<!--
	One capture file as Files edits it: its complete text, frontmatter
	included, saved exactly as typed through the draft the page holds for the
	file. It stays a text editor whether or not the text reads as a capture,
	including after a repair; Open as capture is the way to the timeline's
	view of it.
-->
<script lang="ts">
	import { toTextarea } from '@epicenter/capture';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Loading } from '@epicenter/ui/loading';
	import { Textarea } from '@epicenter/ui/textarea';
	import { onDestroy, untrack } from 'svelte';
	import type { Captures } from '$lib/captures.svelte.js';
	import type { Draft } from '$lib/draft.svelte.js';
	import CaptureActions from './CaptureActions.svelte';
	import DraftRecovery from './DraftRecovery.svelte';
	import TechnicalDetails from './TechnicalDetails.svelte';

	let {
		draft: given,
		captures,
		onBack,
		onDeleted,
		onOpen,
		onCapture,
	}: {
		/** The draft this view is for, for its whole lifetime; another draft mounts another view. */
		draft: Draft;
		captures: Captures;
		onBack: () => void;
		/** Completion belongs to the app container even after deletion removes this view. */
		onDeleted: (stem: string) => void;
		onOpen: (stem: string) => void;
		/** Show this file as the timeline edits it: its text and thoughts. */
		onCapture: (stem: string) => void;
	} = $props();

	/** The draft this view was mounted for, read once; see `CaptureDetail`. */
	const draft = untrack(() => given);
	const stem = draft.stem;

	/** Cleared on destroy, for this view's commands. The text box has its own lifetime (`Textarea`). */
	let mounted = true;
	onDestroy(() => {
		mounted = false;
	});

	const held = $derived(!draft.admitted);
</script>

{#if !draft.loaded}
	{#if draft.refused}
		<Alert.Root variant="destructive" aria-label="File unavailable">
			<Alert.Title>{draft.refused.missing ? 'This file is not in the folder' : 'This file cannot be read'}</Alert.Title>
			<Alert.Description>It was not changed by this window. Check again once it is back or repaired.</Alert.Description>
			<div class="mt-2 text-foreground"><Button variant="outline" size="sm" onclick={() => captures.refresh()}>Check again</Button></div>
			<TechnicalDetails detail={draft.refused.message} />
		</Alert.Root>
	{:else}
		<Loading label="Opening…" />
	{/if}
{:else}
	<div class="flex flex-col gap-4">
		<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
			<h1 class="mr-auto min-w-0 basis-full break-all font-mono text-base font-semibold sm:basis-auto">{draft.path}</h1>
			<Button variant="outline" size="sm" onclick={() => {
				if (mounted) onCapture(stem);
			}}>Open as capture</Button>
			<CaptureActions {draft} {captures} {onDeleted} />
		</div>

		{#if draft.deletionProblem && !draft.deletionReview}
			<Alert.Root variant="destructive">
				<Alert.Title>This capture was not deleted</Alert.Title>
				<Alert.Description>{draft.deletionProblem}</Alert.Description>
			</Alert.Root>
		{/if}

		<DraftRecovery {draft} {captures} {onBack} {onOpen} />

		{#if draft.refusal}
			<Alert.Root aria-label="Not applied">
				<Alert.Title>Not applied</Alert.Title>
				<Alert.Description>{draft.refusal}</Alert.Description>
			</Alert.Root>
		{/if}

		{#if draft.hasUnsentInput}
			<Alert.Root aria-label="Unsent thought">
				<Alert.Title>A thought is not added yet</Alert.Title>
				<Alert.Description>It is kept with this capture and is not part of this text. Open as capture to add or clear it.</Alert.Description>
			</Alert.Root>
		{/if}

		<Field.Field>
			<Field.Label for="file-text">File text</Field.Label>
			<Field.Description>It saves exactly as you type, frontmatter included.</Field.Description>
			<Textarea
				id="file-text"
				readonly={held}
				bind:value={
					() => toTextarea(draft.source),
					draft.inputSource
				}
				rows={18}
				spellcheck={false}
				class="min-h-64 resize-y font-mono"
			/>
		</Field.Field>

		{#if draft.problem !== undefined}
			<Alert.Root aria-label="Needs repair">
				<Alert.Title>This file does not read as a capture</Alert.Title>
				<Alert.Description>
					<p>{draft.problem}</p>
					{#if draft.reading.parseError}
						<ul class="list-disc pl-5">
							{#each draft.reading.parseError.diagnostics as diagnostic, index (index)}
								{#if diagnostic.message !== draft.reading.parseError.message}<li>{diagnostic.message}</li>{/if}
							{/each}
						</ul>
					{/if}
					<p>It saves as you type, so you can repair it here. The timeline lists it again once it reads as a capture.</p>
				</Alert.Description>
			</Alert.Root>
		{/if}
	</div>
{/if}
