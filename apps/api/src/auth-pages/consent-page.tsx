import { raw } from 'hono/html';

/**
 * Client-side script for the OAuth consent page.
 *
 * Sends the user's consent decision (approve/deny) to the Better Auth
 * consent endpoint with `oauth_query` (signed URL params from the
 * authorize redirect). On success, navigates to the redirect URL
 * returned by Better Auth to complete the OAuth flow.
 */
const CONSENT_SCRIPT = raw(`<script>
(function() {
	var approveBtn = document.getElementById('approve');
	var denyBtn = document.getElementById('deny');
	var msg = document.getElementById('msg');
	var scope = document.getElementById('scope').value;

	function getOAuthQuery() {
		var params = new URLSearchParams(window.location.search);
		return params.has('sig') ? params.toString() : undefined;
	}

	function show(text, type) {
		msg.textContent = text;
		msg.className = 'msg ' + type;
	}

	function setLoading(on) {
		approveBtn.disabled = on;
		denyBtn.disabled = on;
	}

	async function sendConsent(accept) {
		setLoading(true);
		msg.className = 'msg hidden';

		try {
			var res = await fetch('/auth/oauth2/consent', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({
					accept: accept,
					scope: scope || undefined,
					oauth_query: getOAuthQuery(),
				}),
			});

			if (!res.ok) {
				var data = await res.json().catch(function() { return {}; });
				show(data.message || data.error || 'Something went wrong.', 'err');
				setLoading(false);
				return;
			}

			// Better Auth returns { redirect: true, url: "..." } for fetch
			// requests instead of a 302 redirect (see handleRedirect).
			var data = await res.json().catch(function() { return {}; });
			if (data.url) {
				window.location.href = data.url;
			} else if (res.redirected) {
				window.location.href = res.url;
			} else {
				show(accept ? 'Access granted.' : 'Access denied.', 'ok');
			}
		} catch (err) {
			show('Network error. Check your connection and try again.', 'err');
			setLoading(false);
		}
	}

	approveBtn.addEventListener('click', function() { sendConsent(true); });
	denyBtn.addEventListener('click', function() { sendConsent(false); });
})();
</script>`);

/**
 * Server-rendered OAuth consent page.
 *
 * Better Auth redirects here when a client application requests access to
 * the user's account. The page shows which application is requesting access,
 * the requested scopes, and approve/deny buttons.
 *
 * Query params (set by Better Auth):
 * - `consent_code` — identifies the authorization request
 * - `client_id` — the requesting application
 * - `scope` — space-separated list of requested scopes
 */
export function ConsentPage({
	consentCode,
	clientId,
	scope,
}: {
	consentCode?: string;
	clientId?: string;
	scope?: string;
}) {
	const scopes = scope ? scope.split(' ').filter(Boolean) : [];

	return (
		<>
			<h1>Authorize application</h1>
			<p class="subtitle">
				<span class="client-name">{clientId ?? 'An application'}</span> is
				requesting access to your Epicenter account.
			</p>

			{scopes.length > 0 && (
				<>
					<label>Requested permissions</label>
					<ul class="scope-list">
						{scopes.map((s) => (
							<li>{s}</li>
						))}
					</ul>
				</>
			)}

			<input type="hidden" id="consent-code" value={consentCode ?? ''} />
			<input type="hidden" id="scope" value={scope ?? ''} />

			<div id="msg" class="msg hidden" />

			<div class="actions">
				<button type="button" class="btn btn-primary" id="approve">
					Approve
				</button>
				<button type="button" class="btn btn-danger" id="deny">
					Deny
				</button>
			</div>

			{CONSENT_SCRIPT}
		</>
	);
}
