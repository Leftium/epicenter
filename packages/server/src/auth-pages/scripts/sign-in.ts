import { raw } from 'hono/html';

/**
 * Client-side script for the sign-in page.
 *
 * Starts Google sign-in via `fetch` and displays errors. Includes
 * `oauth_query` (signed URL params) in the request so Better Auth's
 * after-hook can continue the OAuth flow. On success, navigates to the
 * returned redirect URL or the followed redirect. Local email/password is
 * disabled (see {@link BASE_AUTH_CONFIG}), so Google is the only method here.
 */
export const SIGN_IN_SCRIPT = raw(`<script>
(() => {
	const googleBtn = document.getElementById('google-btn');
	const msg = document.getElementById('msg');

	// Replicate what oauthProviderClient does: parse the signed OAuth
	// query params from the URL so Better Auth can continue the flow.
	const getOAuthQuery = () => {
		const params = new URLSearchParams(window.location.search);
		return params.has('sig') ? params.toString() : undefined;
	};

	const showError = (text) => {
		msg.textContent = text;
		msg.className = 'msg err';
	};

	const clearError = () => {
		msg.className = 'msg hidden';
	};

	googleBtn.addEventListener('click', async () => {
		clearError();
		googleBtn.disabled = true;

		try {
			const body = {
				provider: 'google',
				callbackURL: window.location.href,
			};
			const oauthQuery = getOAuthQuery();
			if (oauthQuery) body.oauth_query = oauthQuery;

			const res = await fetch('/auth/sign-in/social', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify(body),
			});

			const data = await res.json().catch(() => ({}));
			if (data.url) {
				window.location.href = data.url;
			} else if (res.redirected) {
				window.location.href = res.url;
			} else {
				showError(data.message || data.error || 'Failed to start Google sign-in.');
				googleBtn.disabled = false;
			}
		} catch (err) {
			showError('Network error. Check your connection and try again.');
			googleBtn.disabled = false;
		}
	});
})();
</script>`);
