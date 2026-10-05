<!--
	The exact text of one word's file, while its source is the word's view.

	Each keystroke goes to the word's row editor as the file's whole text, in
	the file's own line endings.

	It has its own lifetime: Svelte never removes the listeners its bindings
	add to an element, so this textarea, once removed, can still deliver input.
	Its setter returns once this field is destroyed. It reads `word` when it
	runs, so a field given another word edits that word.
-->
<script lang="ts">
	import { Textarea } from '@epicenter/ui/textarea';
	import { onDestroy } from 'svelte';
	import type { Word } from '$lib/word.svelte.js';

	let { word, label, oninput }: {
		word: Word;
		label: string;
		/** After each keystroke the word took. */
		oninput: () => void;
	} = $props();

	let live = true;
	onDestroy(() => {
		live = false;
	});
</script>

<Textarea
	class="min-h-24 font-mono text-xs"
	aria-label={label}
	readonly={word.fenced}
	bind:value={
		() => word.repairText(),
		(text) => {
			if (!live) return;
			word.inputRepair(text);
			oninput();
		}
	}
/>
