<!--
	A text box bound to a draft through the caller's functions, with its own
	lifetime.

	`read` and `write` are called at each event, so they reach the draft the
	caller has then, and `write` decides whether its view may still take
	input. Svelte never removes the listener its binding adds to an element: a
	text box something still holds can deliver input after its block is gone,
	and a new block can make the same view eligible again. So this control
	stops writing for good once its own instance is destroyed, whatever the
	view around it does next.
-->
<script lang="ts">
	import { Textarea } from '@epicenter/ui/textarea';
	import { type ComponentProps, onDestroy } from 'svelte';

	let {
		read,
		write,
		ref = $bindable(null),
		...rest
	}: {
		/** The text to show, read at each update. */
		read: () => string;
		/** Take typed text, if the view it belongs to still takes input. */
		write: (value: string) => void;
	} & Omit<ComponentProps<typeof Textarea>, 'value'> = $props();

	let live = true;
	onDestroy(() => {
		live = false;
	});
</script>

<Textarea
	bind:ref
	{...rest}
	bind:value={
		() => read(),
		(value) => {
			if (live) write(value ?? '');
		}
	}
/>
