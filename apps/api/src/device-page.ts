/**
 * Minimal HTML verification page for the OAuth device authorization flow (RFC 8628).
 *
 * Served at `/device` by the Hono app. The user enters the code displayed by the runner,
 * clicks Approve, and the runner's polling loop picks up the token automatically.
 *
 * Session cookies from `epicenter.so` work here via cross-subdomain cookies
 * (`domain: 'epicenter.so'`), so the user only needs to sign in once.
 */
export function devicePage(userCode?: string) {
	const prefilled = userCode ? escapeHtml(userCode) : '';

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize Device — Epicenter</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fafafa;color:#111;padding:1rem}
.card{background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:2.5rem;max-width:380px;width:100%}
h1{font-size:1.25rem;font-weight:600;margin-bottom:.25rem}
.subtitle{color:#666;font-size:.875rem;margin-bottom:1.5rem}
label{display:block;font-size:.875rem;font-weight:500;margin-bottom:.5rem}
input{width:100%;padding:.625rem .75rem;border:1px solid #d1d5db;border-radius:8px;font-size:1.125rem;font-family:monospace;letter-spacing:.15em;text-align:center;text-transform:uppercase;outline:none;transition:border-color .15s}
input:focus{border-color:#111;box-shadow:0 0 0 1px #111}
.actions{display:flex;gap:.5rem;margin-top:1rem}
button{flex:1;padding:.625rem 1rem;border-radius:8px;font-size:.875rem;font-weight:500;cursor:pointer;border:1px solid transparent;transition:opacity .15s}
button:disabled{opacity:.5;cursor:not-allowed}
.btn-approve{background:#111;color:#fff;border-color:#111}
.btn-approve:hover:not(:disabled){opacity:.85}
.btn-deny{background:#fff;color:#111;border-color:#d1d5db}
.btn-deny:hover:not(:disabled){background:#f5f5f5}
.msg{margin-top:1rem;padding:.75rem;border-radius:8px;font-size:.875rem;line-height:1.4}
.msg.ok{background:#f0fdf4;color:#166534;border:1px solid #bbf7d0}
.msg.err{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}
.msg.warn{background:#fffbeb;color:#92400e;border:1px solid #fde68a}
.hidden{display:none}
</style>
</head>
<body>
<div class="card">
	<h1>Authorize device</h1>
	<p class="subtitle">Enter the code shown by Epicenter Runner.</p>
	<form id="form">
		<label for="code">Device code</label>
		<input id="code" name="code" type="text" required autocomplete="off"
			placeholder="ABCD-1234" maxlength="20" value="${prefilled}">
		<div class="actions">
			<button type="submit" class="btn-approve" id="approve">Approve</button>
			<button type="button" class="btn-deny" id="deny">Deny</button>
		</div>
	</form>
	<div id="msg" class="msg hidden"></div>
</div>
<script>
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
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
