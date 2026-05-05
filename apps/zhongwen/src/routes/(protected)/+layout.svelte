<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy } from 'svelte';
	import { auth } from '$lib/auth';
	import { openZhongwen, setZhongwen } from '$lib/zhongwen/browser';

	let { data, children } = $props();

	// svelte-ignore state_referenced_locally
	const zhongwen = openZhongwen({ identity: data.identity });
	setZhongwen(zhongwen);
	onDestroy(() => zhongwen[Symbol.dispose]());

	const unsubscribe = auth.onChange((next) => {
		if (next === null) return void goto('/sign-in', { replaceState: true });
		if (next.user.id !== data.identity.user.id) return window.location.reload();
		zhongwen.encryption.applyKeys(next.encryptionKeys);
	});
	onDestroy(unsubscribe);
</script>

{@render children()}
