<script lang="ts">
	import { AuthForm } from '@epicenter/svelte/auth-form';
	import { Toaster } from '@epicenter/ui/sonner';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { SvelteQueryDevtools } from '@tanstack/svelte-query-devtools';
	import { ModeWatcher } from 'mode-watcher';
	import { auth } from '$lib/auth';
	import { queryClient } from '$lib/query/client';
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head><title>Billing — Epicenter</title></svelte:head>

<QueryClientProvider client={queryClient}>
	<div class="min-h-screen bg-background text-foreground">
		{#if auth.isAuthenticated}
			<div class="mx-auto max-w-5xl px-6 py-12">
				<header class="mb-10 flex items-center justify-between">
					<div>
						<h1 class="text-2xl font-semibold tracking-tight">Billing</h1>
						<p class="mt-1 text-sm text-muted-foreground">
							Manage your plan, credits, and usage.
						</p>
					</div>
					<button
						class="text-sm text-muted-foreground hover:text-foreground transition-colors"
						onclick={() => auth.signOut()}
					>
						Sign out
					</button>
				</header>
				{@render children()}
			</div>
		{:else}
			<div class="flex min-h-screen items-center justify-center">
				<AuthForm
					{auth}
					syncNoun="billing"
					onSocialSignIn={() =>
						auth.signInWithSocialRedirect({
							provider: 'google',
							callbackURL: window.location.href,
						})}
				/>
			</div>
		{/if}
	</div>
</QueryClientProvider>

<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
<SvelteQueryDevtools client={queryClient} buttonPosition="bottom-right" />
