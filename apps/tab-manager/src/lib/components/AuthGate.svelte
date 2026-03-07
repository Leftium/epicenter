<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import type { Snippet } from 'svelte';
	import { Err, tryAsync } from 'wellcrafted/result';
	import { authToken, checkSession, signIn, signOut } from '$lib/state/auth.svelte';
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

	// React to token changes (e.g. cleared by another context)
	$effect(() => {
		if (!authToken.current && authState === 'signed-in') {
			authState = 'signed-out';
		}
	});
</script>

{#if authState === 'checking'}
	<div class="flex h-full items-center justify-center">
		<p class="text-sm text-muted-foreground">Checking session…</p>
	</div>
{:else if authState === 'signed-out'}
	<div class="flex h-full items-center justify-center p-6">
		<form
			onsubmit={async (e) => {
				e.preventDefault();
				error = '';
				loading = true;
				const { error: signInError } = await tryAsync({
					try: () => signIn(email, password),
					catch: (e) => Err(e instanceof Error ? e.message : 'Sign-in failed'),
				});
				if (signInError) {
					error = signInError;
				} else {
					authState = 'signed-in';
					password = '';
					reconnectSync();
				}
				loading = false;
			}}
			class="w-full max-w-xs"
		>
			<Field.Set>
				<Field.Legend>Sign in</Field.Legend>
				<Field.Description>Sign in to sync your tabs across devices.</Field.Description>
				<Field.Separator />

				{#if error}
					<Alert.Root variant="destructive">
						<Alert.Description>{error}</Alert.Description>
					</Alert.Root>
				{/if}

				<Field.Group>
					<Field.Field>
						<Field.Label for="email">Email</Field.Label>
						<Input id="email" type="email" placeholder="Email" bind:value={email} required autocomplete="email" />
					</Field.Field>
					<Field.Field>
						<Field.Label for="password">Password</Field.Label>
						<Input id="password" type="password" placeholder="Password" bind:value={password} required autocomplete="current-password" />
					</Field.Field>
				</Field.Group>

				<Button type="submit" class="w-full" disabled={loading}>
					{loading ? 'Signing in…' : 'Sign in'}
				</Button>
			</Field.Set>
		</form>
	</div>
{:else}
	{@render children()}
	<div class="border-t px-3 py-2 flex items-center justify-end">
		<Button
			variant="ghost"
			size="sm"
			onclick={async () => {
				await signOut();
				authState = 'signed-out';
				reconnectSync();
			}}
		>
			Sign out
		</Button>
	</div>
{/if}
