<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { auth } from '$lib/auth';

	let submitError = $state<string | null>(null);

	const unsubscribe = auth.onChange((next) => {
		if (next !== null) void goto('/', { replaceState: true });
	});
	onDestroy(unsubscribe);

	async function signInWithGoogle() {
		const { error } = await auth.signInWithSocialRedirect({
			provider: 'google',
			callbackURL: window.location.origin,
		});
		if (error) submitError = error.message;
	}
</script>

<main class="flex h-dvh flex-col">
	<header class="flex items-center justify-between border-b px-4 py-3">
		<h1 class="text-lg font-semibold">中文 Zhongwen</h1>
		<Button size="sm" onclick={signInWithGoogle}>Sign In</Button>
	</header>

	<div class="flex flex-1 items-center justify-center">
		<div class="text-center text-muted-foreground">
			<p class="mb-4">Sign in to start chatting</p>
			{#if submitError}
				<p class="text-sm text-destructive">{submitError}</p>
			{/if}
			<Button onclick={signInWithGoogle}>Sign in with Google</Button>
		</div>
	</div>
</main>
