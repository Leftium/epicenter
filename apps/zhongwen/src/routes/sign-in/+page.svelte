<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Loading } from '@epicenter/ui/loading';
	import { goto } from '$app/navigation';
	import { auth } from '$platform/auth';

	let submitError = $state<string | null>(null);

	$effect(() => {
		if (auth.state.status === 'signed-in') {
			void goto('/', { replaceState: true });
		}
	});

	async function signInWithSocial() {
		const { error } = await auth.signInWithSocial({ provider: 'google' });
		if (error) submitError = error.message;
	}
</script>

{#if auth.state.status === 'pending'}
	<Loading class="h-dvh" />
{:else if auth.state.status === 'signed-out'}
	<main class="flex h-dvh flex-col">
		<header class="flex items-center justify-between border-b px-4 py-3">
			<h1 class="text-lg font-semibold">中文 Zhongwen</h1>
			<Button size="sm" onclick={signInWithSocial}>Sign In</Button>
		</header>

		<div class="flex flex-1 items-center justify-center">
			<div class="text-center text-muted-foreground">
				<p class="mb-4">Sign in to start chatting</p>
				{#if submitError}
					<p class="text-sm text-destructive">{submitError}</p>
				{/if}
				<Button onclick={signInWithSocial}>Sign in with Google</Button>
			</div>
		</div>
	</main>
{/if}
