<!--
	Gives the block inside it a lifetime of its own. `live()` is true from when
	the block mounts until it is destroyed, and false for good after that.

	A control can deliver input after its block is gone: Svelte never removes
	the listeners its bindings add to an element, and something may still hold
	the element or a handler. Native control handlers and commands check
	`live()` first. Shared Input and Textarea retire their value bindings
	themselves. When the same kind of block mounts again it gets a new
	lifetime, so the fresh control works and the old one never does. The block
	still mounts only when its condition changes, never per input.
-->
<script lang="ts">
	import { onDestroy, type Snippet } from 'svelte';

	let { children }: { children: Snippet<[() => boolean]> } = $props();

	let alive = true;
	onDestroy(() => {
		alive = false;
	});
	const live = () => alive;
</script>

{@render children(live)}
