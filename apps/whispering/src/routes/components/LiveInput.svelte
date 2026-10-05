<!--
	A text input bound to a draft through `get` and `set`, functions that read
	the draft the view shows when they run. Like LiveTextarea, it has a
	lifetime of its own: once destroyed, its setter delivers nothing ever
	again, whatever still holds the element and whatever view returns.
-->
<script lang="ts">
	import { Input } from '@epicenter/ui/input';
	import { onDestroy } from 'svelte';
	import type { HTMLInputAttributes } from 'svelte/elements';

	let {
		get,
		set,
		...rest
	}: Omit<HTMLInputAttributes, 'value' | 'type' | 'files'> & {
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

<Input bind:value={read, write} {...rest} />
