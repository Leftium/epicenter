<script lang="ts">
	import { AuthForm } from '@epicenter/svelte/auth-form';
	import { goto } from '$app/navigation';
	import { auth } from '$platform/auth';

	$effect(() => {
		if (auth.state.status === 'signed-in') {
			goto('/', { replaceState: true });
		}
	});
</script>

{#if auth.state.status === 'signed-out'}
	<div class="flex h-dvh items-center justify-center">
		<AuthForm
			{auth}
			syncNoun="entries"
			onSocialSignIn={() =>
				auth.signInWithSocialRedirect({
					provider: 'google',
					callbackURL: window.location.origin,
				})}
		/>
	</div>
{/if}
