<script lang="ts">
	import { SignedOutScreen } from '@epicenter/app-shell/instance-settings';
	import { goto } from '$app/navigation';
	import { instanceSetting } from '$lib/instance';
	import { auth } from '$platform/auth';

	$effect(() => {
		if (auth.state.status === 'signed-in') {
			void goto('/', { replaceState: true });
		}
	});
</script>

<SignedOutScreen
	appName="中文 Vocab"
	tagline="Sign in to start chatting."
	{auth}
	setting={instanceSetting}
/>
