<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { checkSession, signIn, signOut, watchAuthToken } from '$lib/state/auth';
	import { reconnectSync } from '$lib/workspace';

	let { children }: { children: Snippet } = $props();

	type AuthState = 'checking' | 'signed-out' | 'signed-in';

	let authState = $state<AuthState>('checking');
	let email = $state('');
	let password = $state('');
	let error = $state('');
	let loading = $state(false);

	// Check session on mount
	$effect(() => {
		checkSession().then((user) => {
			authState = user ? 'signed-in' : 'signed-out';
		});
	});

	// Watch for token changes (e.g. cleared by another context)
	$effect(() => {
		const unwatch = watchAuthToken((token) => {
			if (!token && authState === 'signed-in') {
				authState = 'signed-out';
			}
		});
		return unwatch;
	});

	async function handleSignIn(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		loading = true;
		try {
			await signIn(email, password);
			authState = 'signed-in';
			password = '';
			reconnectSync();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Sign-in failed';
		} finally {
			loading = false;
		}
	}

	async function handleSignOut() {
		await signOut();
		authState = 'signed-out';
		reconnectSync();
	}
</script>

{#if authState === 'checking'}
	<div class="flex h-full items-center justify-center">
		<p class="text-sm text-muted-foreground">Checking session…</p>
	</div>
{:else if authState === 'signed-out'}
	<div class="flex h-full items-center justify-center p-6">
		<form onsubmit={handleSignIn} class="w-full max-w-xs space-y-4">
			<div class="space-y-1 text-center">
				<h2 class="text-lg font-semibold">Sign in</h2>
				<p class="text-sm text-muted-foreground">
					Sign in to sync your tabs across devices.
				</p>
			</div>

			{#if error}
				<p class="text-sm text-destructive">{error}</p>
			{/if}

			<div class="space-y-3">
				<Input
					type="email"
					placeholder="Email"
					bind:value={email}
					required
					autocomplete="email"
				/>
				<Input
					type="password"
					placeholder="Password"
					bind:value={password}
					required
					autocomplete="current-password"
				/>
			</div>

			<Button type="submit" class="w-full" disabled={loading}>
				{loading ? 'Signing in…' : 'Sign in'}
			</Button>
		</form>
	</div>
{:else}
	{@render children()}
	<div class="border-t px-3 py-2 flex items-center justify-end">
		<Button variant="ghost" size="sm" onclick={handleSignOut}>
			Sign out
		</Button>
	</div>
{/if}
