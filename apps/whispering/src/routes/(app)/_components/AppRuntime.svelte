<!--
	App-session runtime root. This component owns only the launch boundary: it
	mounts once in the app layout and attaches each runtime owner exactly once.
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { runtimeOwners } from '../_runtime/runtime-owners.js';

	const cleanups = runtimeOwners
		.map((owner) => owner.attach())
		.filter((cleanup): cleanup is () => void => typeof cleanup === 'function');

	onDestroy(() => {
		for (const cleanup of cleanups.toReversed()) cleanup();
	});
</script>
