import { raw } from 'hono/html';

/**
 * Google's multi-color logo SVG for the "Continue with Google" button.
 * Rendered as raw HTML to avoid JSX SVG attribute noise.
 */
const GOOGLE_ICON =
	raw(`<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
	<path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
	<path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
	<path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
	<path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
</svg>`);

/**
 * Client-side script for the sign-in/sign-up page.
 *
 * Handles form submission via `fetch`, mode toggling between sign-in and
 * sign-up, and error display. On success, reloads the page so Better Auth
 * can detect the session and continue the OAuth flow automatically.
 */
const SIGN_IN_SCRIPT = raw(`<script>
(function() {
	var form = document.getElementById('auth-form');
	var emailInput = document.getElementById('email');
	var passwordInput = document.getElementById('password');
	var nameField = document.getElementById('name-field');
	var nameInput = document.getElementById('name');
	var submitBtn = document.getElementById('submit-btn');
	var submitText = document.getElementById('submit-text');
	var googleBtn = document.getElementById('google-btn');
	var toggleBtn = document.getElementById('toggle-btn');
	var togglePrompt = document.getElementById('toggle-prompt');
	var msg = document.getElementById('msg');

	var isSignUp = false;

	function showError(text) {
		msg.textContent = text;
		msg.className = 'msg err';
	}

	function clearError() {
		msg.className = 'msg hidden';
	}

	function setLoading(on) {
		submitBtn.disabled = on;
		googleBtn.disabled = on;
		emailInput.disabled = on;
		passwordInput.disabled = on;
		if (nameInput) nameInput.disabled = on;
		submitText.textContent = on
			? (isSignUp ? 'Creating account\\u2026' : 'Signing in\\u2026')
			: (isSignUp ? 'Create account' : 'Sign in');
	}

	function toggleMode() {
		isSignUp = !isSignUp;
		clearError();

		document.getElementById('heading').textContent = isSignUp ? 'Create account' : 'Sign in';
		document.getElementById('description').textContent = isSignUp
			? 'Create an account to get started with Epicenter.'
			: 'Sign in to your Epicenter account.';
		submitText.textContent = isSignUp ? 'Create account' : 'Sign in';
		togglePrompt.textContent = isSignUp ? 'Already have an account? ' : "Don't have an account? ";
		toggleBtn.textContent = isSignUp ? 'Sign in' : 'Sign up';
		nameField.style.display = isSignUp ? 'block' : 'none';
		passwordInput.autocomplete = isSignUp ? 'new-password' : 'current-password';

		if (isSignUp && nameInput) nameInput.required = true;
		else if (nameInput) nameInput.required = false;
	}

	toggleBtn.addEventListener('click', toggleMode);

	form.addEventListener('submit', async function(e) {
		e.preventDefault();
		clearError();
		setLoading(true);

		var endpoint = isSignUp ? '/auth/sign-up/email' : '/auth/sign-in/email';
		var body = { email: emailInput.value, password: passwordInput.value };
		if (isSignUp && nameInput) body.name = nameInput.value;

		try {
			var res = await fetch(endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify(body),
			});

			if (!res.ok) {
				var data = await res.json().catch(function() { return {}; });
				showError(data.message || data.error || 'Something went wrong. Try again.');
				setLoading(false);
				return;
			}

			// Session created. Reload so Better Auth continues the OAuth flow.
			window.location.reload();
		} catch (err) {
			showError('Network error. Check your connection and try again.');
			setLoading(false);
		}
	});

	googleBtn.addEventListener('click', function() {
		// Redirect to Better Auth's social sign-in endpoint.
		// callbackURL = current page so Better Auth returns here after Google auth,
		// detects the session, and continues the OAuth flow.
		var callbackUrl = encodeURIComponent(window.location.href);
		window.location.href = '/auth/sign-in/social?provider=google&callbackURL=' + callbackUrl;
	});
})();
</script>`);

/**
 * Server-rendered sign-in/sign-up page for the OAuth flow.
 *
 * Better Auth redirects here when a user needs to authenticate. The page
 * renders a form with email/password fields and a Google OAuth button.
 * After successful auth, the page reloads and Better Auth automatically
 * continues the OAuth authorization flow.
 */
export function SignInPage() {
	return (
		<>
			<h1 id="heading">Sign in</h1>
			<p class="subtitle" id="description">
				Sign in to your Epicenter account.
			</p>

			<div id="msg" class="msg hidden" />

			<button type="button" class="btn btn-outline" id="google-btn">
				{GOOGLE_ICON}
				Continue with Google
			</button>

			<div class="separator">or</div>

			<form id="auth-form">
				<div class="field" id="name-field" style="display:none">
					<label for="name">Name</label>
					<input id="name" type="text" placeholder="Name" autocomplete="name" />
				</div>
				<div class="field">
					<label for="email">Email</label>
					<input
						id="email"
						type="email"
						placeholder="Email"
						required
						autocomplete="email"
					/>
				</div>
				<div class="field">
					<label for="password">Password</label>
					<input
						id="password"
						type="password"
						placeholder="Password"
						required
						autocomplete="current-password"
					/>
				</div>

				<button type="submit" class="btn btn-primary" id="submit-btn">
					<span id="submit-text">Sign in</span>
				</button>
			</form>

			<p class="toggle">
				<span id="toggle-prompt">Don't have an account? </span>
				<button type="button" id="toggle-btn">
					Sign up
				</button>
			</p>

			{SIGN_IN_SCRIPT}
		</>
	);
}
