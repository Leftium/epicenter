<script lang="ts">
	import { onDestroy } from 'svelte';
	import { runtimeOwners } from '../_runtime/runtime-owners';

	// Headless component: the single, stable owner of everything that starts when
	// Whispering starts. It mounts once at the session root, outside the
	// responsive nav branch, so crossing a layout breakpoint never re-runs any
	// runtime owner.
	const detachRuntimeOwners = runtimeOwners.map((owner) => owner.attach());

	onDestroy(() => {
		for (const detach of detachRuntimeOwners.toReversed()) detach();
	});
</script>
