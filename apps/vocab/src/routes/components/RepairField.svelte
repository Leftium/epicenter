<!--
	The exact text of one word's file, while its source is the word's view.

	Each keystroke goes to the word's row editor as the file's whole text, in
	the file's own line endings.

	The shared Textarea retires its binding when destroyed. The binding reads
	`word` at the event, so a field given another word edits that word.
-->
<script lang="ts">
	import { Textarea } from '@epicenter/ui/textarea';
	import type { Word } from '$lib/word.svelte.js';

	let { word, label, oninput }: {
		word: Word;
		label: string;
		/** After each keystroke the word took. */
		oninput: () => void;
	} = $props();
</script>

<Textarea
	class="min-h-24 font-mono text-xs"
	aria-label={label}
	readonly={word.fenced}
	bind:value={
		() => word.repairText(),
		(text) => {
			word.inputRepair(text);
			oninput();
		}
	}
/>
