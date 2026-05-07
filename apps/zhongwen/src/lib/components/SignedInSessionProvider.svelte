<script lang="ts">
	import type { Snippet } from 'svelte';
	import { setSignedInSession, type ZhongwenSignedIn } from '$lib/session.svelte';

	let {
		signedIn,
		children,
	}: {
		signedIn: ZhongwenSignedIn;
		children: Snippet;
	} = $props();

	// Capture the prop reference once at mount. Stable for the provider's
	// lifetime: createSession reuses signedIn for same-user re-emits and
	// reloads the page on user switch, so this never points at a stale value.
	// svelte-ignore state_referenced_locally
	setSignedInSession(signedIn);
</script>

{@render children()}
