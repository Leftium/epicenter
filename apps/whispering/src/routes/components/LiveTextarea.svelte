<!--
	A textarea bound to a draft through `get` and `set`, functions that read
	the draft the view shows when they run. This control has a lifetime of its
	own: once it is destroyed, as when its view's mode or the file's
	readability changes, its setter delivers nothing ever again, even though
	Svelte leaves its input listener on an element something may still hold,
	and even after the same view mode returns with a new control.
-->
<script lang="ts">
	import { Textarea } from '@epicenter/ui/textarea';
	import { onDestroy } from 'svelte';
	import type { HTMLTextareaAttributes } from 'svelte/elements';

	let {
		get,
		set,
		...rest
	}: Omit<HTMLTextareaAttributes, 'value'> & {
		get: () => string;
		set: (value: string) => void;
	} = $props();

	let alive = true;
	/** What it last showed; read once it is gone, so nothing of the draft is read then. */
	let shown = '';
	onDestroy(() => {
		alive = false;
	});
	const read = () => (alive ? (shown = get()) : shown);
	const write = (value: string) => {
		if (alive) set(value);
	};
</script>

<Textarea bind:value={read, write} {...rest} />
