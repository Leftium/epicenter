<!--
	The note field of one word, while its fields are the word's view.

	Each keystroke goes to the word's row editor as the whole word. The card
	opens the editor when it shows the word; until then the field is disabled,
	so nothing can be typed that would not be taken. A note no row can hold is
	kept in the field as typed, and the card says why.

	It has its own lifetime: Svelte never removes the listeners its bindings
	add to an element, so this textarea, once removed, can still deliver input.
	Its setter returns once this field is destroyed. It reads `word` when it
	runs, so a field given another word edits that word.
-->
<script lang="ts">
	import { Textarea } from '@epicenter/ui/textarea';
	import { onDestroy } from 'svelte';
	import type { Word } from '$lib/word.svelte.js';

	let { word, label }: { word: Word; label: string } = $props();

	let live = true;
	onDestroy(() => {
		live = false;
	});
</script>

<Textarea
	class="min-h-20 max-h-48 overflow-y-auto"
	aria-label={label}
	placeholder={word.row === undefined && word.opening ? 'Opening…' : 'Your note'}
	disabled={word.row === undefined}
	readonly={word.fenced}
	bind:value={
		() => word.note(),
		(text) => {
			if (live) word.inputNote(text);
		}
	}
/>
