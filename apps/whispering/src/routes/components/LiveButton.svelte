<!--
	A button for a command on a draft. It has a lifetime of its own: once it
	is destroyed, its click does nothing ever again, even when something still
	holds the element and the state that showed it returns with a new button.
-->
<script lang="ts">
	import { Button, type ButtonProps } from '@epicenter/ui/button';
	import { onDestroy } from 'svelte';

	let {
		onclick,
		children,
		...rest
	}: Omit<ButtonProps, 'onclick'> & { onclick: () => void } = $props();

	let alive = true;
	onDestroy(() => {
		alive = false;
	});
</script>

<Button
	{...rest}
	onclick={() => {
		if (alive) onclick();
	}}
>
	{@render children?.()}
</Button>
