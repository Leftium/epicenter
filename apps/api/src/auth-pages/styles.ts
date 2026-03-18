/**
 * Shared CSS for server-rendered auth pages (sign-in, consent, device).
 *
 * Extends the minimal aesthetic from the original device-page: system-ui font,
 * neutral grays, subtle borders, 8–12px radius. No external dependencies—this
 * string is inlined in the `<style>` tag by the layout component.
 */
export const AUTH_STYLES = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

body{
	font-family:system-ui,-apple-system,sans-serif;
	min-height:100vh;
	display:flex;
	align-items:center;
	justify-content:center;
	background:#fafafa;
	color:#111;
	padding:1rem;
	line-height:1.5;
}

.card{
	background:#fff;
	border:1px solid #e5e5e5;
	border-radius:12px;
	padding:2.5rem;
	max-width:400px;
	width:100%;
}

h1{font-size:1.25rem;font-weight:600;margin-bottom:.25rem}
.subtitle{color:#666;font-size:.875rem;margin-bottom:1.5rem}

/* ── Form elements ────────────────────────────────────────── */

label{display:block;font-size:.875rem;font-weight:500;margin-bottom:.375rem}

input{
	width:100%;
	padding:.625rem .75rem;
	border:1px solid #d1d5db;
	border-radius:8px;
	font-size:.875rem;
	font-family:inherit;
	outline:none;
	transition:border-color .15s;
	background:#fff;
	color:#111;
}
input:focus{border-color:#111;box-shadow:0 0 0 1px #111}
input::placeholder{color:#9ca3af}

.field{margin-bottom:.875rem}
.field:last-of-type{margin-bottom:0}

/* ── Buttons ──────────────────────────────────────────────── */

button,.btn{
	display:inline-flex;
	align-items:center;
	justify-content:center;
	gap:.5rem;
	width:100%;
	padding:.625rem 1rem;
	border-radius:8px;
	font-size:.875rem;
	font-weight:500;
	font-family:inherit;
	cursor:pointer;
	border:1px solid transparent;
	transition:opacity .15s,background-color .15s;
	text-decoration:none;
}
button:disabled,.btn:disabled{opacity:.5;cursor:not-allowed}

.btn-primary{background:#111;color:#fff;border-color:#111}
.btn-primary:hover:not(:disabled){opacity:.85}

.btn-outline{background:#fff;color:#111;border-color:#d1d5db}
.btn-outline:hover:not(:disabled){background:#f5f5f5}

.btn-danger{background:#fff;color:#991b1b;border-color:#fecaca}
.btn-danger:hover:not(:disabled){background:#fef2f2}

/* ── Button row (side-by-side) ────────────────────────────── */

.actions{display:flex;gap:.5rem;margin-top:1rem}
.actions button,.actions .btn{flex:1}

/* ── Separator ────────────────────────────────────────────── */

.separator{
	display:flex;
	align-items:center;
	gap:.75rem;
	margin:1.25rem 0;
	color:#9ca3af;
	font-size:.8125rem;
}
.separator::before,.separator::after{
	content:'';
	flex:1;
	height:1px;
	background:#e5e5e5;
}

/* ── Alert / message ──────────────────────────────────────── */

.msg{
	margin-top:1rem;
	padding:.75rem;
	border-radius:8px;
	font-size:.875rem;
	line-height:1.4;
}
.msg.ok{background:#f0fdf4;color:#166534;border:1px solid #bbf7d0}
.msg.err{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}
.msg.warn{background:#fffbeb;color:#92400e;border:1px solid #fde68a}

.hidden{display:none}

/* ── Toggle link ──────────────────────────────────────────── */

.toggle{
	text-align:center;
	font-size:.8125rem;
	color:#666;
	margin-top:1.25rem;
}
.toggle button{
	display:inline;
	width:auto;
	padding:0;
	border:none;
	background:none;
	color:#111;
	text-decoration:underline;
	text-underline-offset:3px;
	cursor:pointer;
	font-size:inherit;
	font-weight:inherit;
}
.toggle button:hover{color:#111;opacity:.7}

/* ── Scope list (consent page) ────────────────────────────── */

.scope-list{
	list-style:none;
	padding:0;
	margin:.75rem 0;
}
.scope-list li{
	padding:.5rem .75rem;
	background:#f9fafb;
	border:1px solid #e5e5e5;
	border-radius:6px;
	font-size:.875rem;
	margin-bottom:.375rem;
}
.scope-list li:last-child{margin-bottom:0}

/* ── Client info (consent page) ───────────────────────────── */

.client-name{
	font-weight:600;
	font-size:1rem;
}

/* ── Device code input override ───────────────────────────── */

.code-input{
	font-family:monospace;
	letter-spacing:.15em;
	text-align:center;
	text-transform:uppercase;
	font-size:1.125rem;
}
`;
