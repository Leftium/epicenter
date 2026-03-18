import { raw } from 'hono/html';

/**
 * Client-side script for the device authorization verification page.
 *
 * Posts the user code to `/auth/device/approve` or `/auth/device/deny`,
 * shows status messages, and hides the form on completion. Preserves the
 * exact behavior of the original `device-page.ts` template.
 */
const DEVICE_SCRIPT = raw(`<script>
(function() {
	var form = document.getElementById('form');
	var code = document.getElementById('code');
	var approve = document.getElementById('approve');
	var deny = document.getElementById('deny');
	var msg = document.getElementById('msg');

	function show(text, type) {
		msg.textContent = text;
		msg.className = 'msg ' + type;
	}

	function setLoading(on) {
		approve.disabled = on;
		deny.disabled = on;
		code.disabled = on;
	}

	async function send(endpoint, userCode) {
		setLoading(true);
		msg.className = 'msg hidden';
		try {
			var res = await fetch('/auth/device/' + endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ userCode: userCode }),
			});
			var data = await res.json();
			if (!res.ok) {
				if (res.status === 401 || data.error === 'unauthorized') {
					show('Sign in first, then come back to this page.', 'warn');
				} else {
					show(data.error_description || data.message || 'Something went wrong.', 'err');
				}
				return;
			}
			if (endpoint === 'approve') {
				show('Device authorized. You can close this page.', 'ok');
				form.classList.add('hidden');
			} else {
				show('Device denied.', 'ok');
				form.classList.add('hidden');
			}
		} catch (e) {
			show('Network error. Check your connection and try again.', 'err');
		} finally {
			setLoading(false);
		}
	}

	form.addEventListener('submit', function(e) {
		e.preventDefault();
		var val = code.value.trim();
		if (val) send('approve', val);
	});

	deny.addEventListener('click', function() {
		var val = code.value.trim();
		if (val) send('deny', val);
	});
})();
</script>`);

/**
 * Server-rendered device authorization verification page (RFC 8628).
 *
 * The user enters the code displayed by Epicenter Runner, clicks Approve,
 * and the runner's polling loop picks up the token automatically. Session
 * cookies from `epicenter.so` work here via cross-subdomain cookies.
 */
export function DevicePage({ userCode }: { userCode?: string }) {
	const prefilled = userCode ? escapeHtml(userCode) : '';

	return (
		<>
			<h1>Authorize device</h1>
			<p class="subtitle">Enter the code shown by Epicenter Runner.</p>

			<form id="form">
				<div class="field">
					<label for="code">Device code</label>
					<input
						id="code"
						name="code"
						type="text"
						required
						autocomplete="off"
						placeholder="ABCD-1234"
						maxlength={20}
						value={prefilled}
						class="code-input"
					/>
				</div>
				<div class="actions">
					<button type="submit" class="btn btn-primary" id="approve">
						Approve
					</button>
					<button type="button" class="btn btn-outline" id="deny">
						Deny
					</button>
				</div>
			</form>

			<div id="msg" class="msg hidden" />

			{DEVICE_SCRIPT}
		</>
	);
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
