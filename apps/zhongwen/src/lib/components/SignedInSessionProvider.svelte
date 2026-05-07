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

	// Plain const capture: read the prop exactly once at mount. Everything
	// below reads `captured`, never `signedIn`. This sidesteps Svelte's
	// teardown semantics: descendants reading getSignedInSession() during
	// the unmount frame walk a closure over plain JS, not a prop signal.
	// svelte-ignore state_referenced_locally
	const captured = signedIn;

	setSignedInSession(captured);
</script>

{@render children()}
