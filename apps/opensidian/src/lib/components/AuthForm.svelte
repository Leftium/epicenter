<script lang="ts">
	import { AuthForm } from '@epicenter/svelte/auth-form';
	import { auth } from '$lib/workspace';
</script>

<AuthForm
	{auth}
	syncNoun="notes"
	onSocialSignIn={() =>
		auth.signInWithSocialRedirect({
			provider: 'google',
			callbackURL: window.location.origin,
		})}
/>
