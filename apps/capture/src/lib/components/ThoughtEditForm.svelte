<!--
	The form that edits one thought: its text box, Save thought, and Cancel.

	It belongs to the one edit open when it was made, and to its own
	lifetime. Svelte leaves a form's submit listener, like a binding's input
	listener, on an element something still holds after its block is gone,
	and a later edit, of another thought or of this same one again, makes the
	view eligible again. So every action names this form's edit, which the
	draft refuses unless it is the edit open now, and this form does nothing
	at all once destroyed. `draft` and `eligible` are still read at each
	event, so a live form acts on the draft its view has then.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { onDestroy, untrack } from 'svelte';
	import type { Draft, ThoughtEdit } from '$lib/draft.svelte.js';
	import { Textarea } from '@epicenter/ui/textarea';

	let {
		draft,
		edit,
		held,
		eligible,
		onSaved,
		onCancelled,
	}: {
		draft: Draft;
		/** The edit open when this form was made. */
		edit: ThoughtEdit;
		/** Nothing a person does is taken now. */
		held: boolean;
		/** Whether the view this form is in takes input now. */
		eligible: () => boolean;
		onSaved: () => void;
		onCancelled: () => void;
	} = $props();

	/** The edit this form was made for; a later edit has another identity. */
	const id = untrack(() => edit.id);
	let live = true;
	onDestroy(() => {
		live = false;
	});
	/** This form is alive, its view takes input, and its edit is the one open now. */
	const own = () => live && eligible() && draft.editing?.id === id;

	const rowsFor = (text: string) => Math.min(12, Math.max(3, text.split('\n').length + 1));

	function submitOnModEnter(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
		if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return;
		event.preventDefault();
		event.currentTarget.form?.requestSubmit();
	}

	function focusAtEnd(node: HTMLTextAreaElement) {
		node.focus();
		node.setSelectionRange(node.value.length, node.value.length);
	}

</script>

<form class="flex flex-col gap-2 py-1" onsubmit={(event) => {
		event.preventDefault();
		if (own() && draft.commitEditing(id)) onSaved();
	}}>
	<Textarea
		aria-label="Thought text"
		readonly={held}
		bind:value={
			() => (draft.editing?.id === id ? draft.editing.text : ''),
			(value) => {
				if (own()) draft.inputEditing(value, id);
			}
		}
		onkeydown={submitOnModEnter}
		rows={rowsFor(draft.editing?.id === id ? draft.editing.text : '')}
		class="leading-relaxed"
		{@attach focusAtEnd}
	/>
	<div class="flex flex-wrap gap-2">
		<Button type="submit" size="sm" disabled={held}>Save thought</Button>
		<Button size="sm" variant="outline" disabled={held} onclick={() => {
			if (!own()) return;
			draft.cancelEditing(id);
			onCancelled();
		}}>Cancel</Button>
	</div>
</form>
