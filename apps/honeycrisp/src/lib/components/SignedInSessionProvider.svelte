<script lang="ts">
	import { onDestroy, type Snippet } from 'svelte';
	import { setSignedInSession, type HoneycrispSignedIn } from '$lib/session.svelte';
	import {
		createHoneycrispState,
		setHoneycrispState,
	} from '../../routes/(signed-in)/state';

	let {
		signedIn,
		children,
	}: {
		signedIn: HoneycrispSignedIn;
		children: Snippet;
	} = $props();

	// Plain const capture: read the prop exactly once at mount. Everything
	// below reads `captured`, never `signedIn`. This sidesteps Svelte's
	// teardown semantics: descendants reading getSignedInSession() during
	// the unmount frame walk a closure over plain JS, not a prop signal.
	// svelte-ignore state_referenced_locally
	const captured = signedIn;

	const honeycrispState = createHoneycrispState(captured.honeycrisp);

	setSignedInSession(captured);
	setHoneycrispState(honeycrispState);

	onDestroy(() => honeycrispState[Symbol.dispose]());
</script>

{@render children()}
