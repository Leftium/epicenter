/**
 * Bun-owned routes on the one trusted Device origin.
 *
 * The built-in route table is deliberately closed and compiled. Rust can mirror
 * the IDs and paths without discovering or loading an application registry, and
 * it derives its own window labels from those IDs: a window label is Tauri's
 * handle, so Bun states no opinion about one. The bootstrap route is host
 * infrastructure: Tauri exchanges the per-launch credential there before any
 * SPA reaches domain code.
 */

import {
	CALLBACK_PATH as MAIL_CALLBACK_PATH,
	PENDING_CALLBACK_PATH as MAIL_PENDING_CALLBACK_PATH,
} from '@epicenter/local-mail/authorization-return';

const stripTrailing = (value: string) => value.replace(/\/+$/, '');

function route(pattern: string) {
	return {
		pattern,
		url: (baseUrl: string) => `${stripTrailing(baseUrl)}${pattern}`,
	} as const;
}

function builtInRoute<const TId extends string>(id: TId, title: string) {
	return {
		id,
		title,
		...route(`/apps/${id}/`),
	};
}

export const BUILT_IN_ROUTES = {
	home: builtInRoute('home', 'Home'),
	whispering: builtInRoute('whispering', 'Whispering'),
	honeycrisp: builtInRoute('honeycrisp', 'Honeycrisp'),
	capture: builtInRoute('capture', 'Capture'),
	mail: builtInRoute('mail', 'Mail'),
	todos: builtInRoute('todos', 'Todos'),
	books: builtInRoute('books', 'Books'),
} as const;

export type BuiltInRouteId = keyof typeof BUILT_IN_ROUTES;

export const BOOTSTRAP_ROUTE = route('/_epicenter/bootstrap');
export const ACCOUNT_SIGN_IN_ROUTE = route('/_epicenter/account/sign-in');
export const SIGN_IN_CALLBACK_ROUTE = route('/_epicenter/sign-in/callback');
export const ACCOUNT_CANCEL_CONNECTION_ROUTE = route(
	'/_epicenter/account/cancel-connection',
);
export const ACCOUNT_SIGN_OUT_ROUTE = route('/_epicenter/account/sign-out');
export const HOME_ROUTE = BUILT_IN_ROUTES.home;
export const WHISPERING_ROUTE = BUILT_IN_ROUTES.whispering;
export const HONEYCRISP_ROUTE = BUILT_IN_ROUTES.honeycrisp;
export const CAPTURE_ROUTE = BUILT_IN_ROUTES.capture;
export const MAIL_ROUTE = BUILT_IN_ROUTES.mail;
export const TODOS_ROUTE = BUILT_IN_ROUTES.todos;
export const BOOKS_ROUTE = BUILT_IN_ROUTES.books;
/** What Home lists as launchable (ADR-0189). */
export const APPLICATIONS_ROUTE = route('/api/apps');
export const SESSION_ROUTE = route('/api/home/session');
export const SESSION_STREAM_ROUTE = route('/api/home/session/stream');
/**
 * Where Google returns a person after Local Mail's consent screen.
 *
 * It is the SPA's own client route, and that is deliberate: Google refuses a
 * custom URI scheme for a Desktop OAuth client, so the only redirect a desktop
 * app may register is a loopback address, and this socket is the loopback
 * address Local Mail already names. The redemption still happens in the Mail
 * WebView, which is the only place the PKCE verifier exists; the host does not
 * read the code, hold a credential, or talk to Google.
 *
 * A request here carries `code` or `error` only when it arrives from the
 * person's browser. Without one it is the WebView loading its own route, and
 * the SPA is served exactly as before.
 */
export const MAIL_CALLBACK_ROUTE = route(
	`${BUILT_IN_ROUTES.mail.pattern}${MAIL_CALLBACK_PATH}`,
);
/** Where the Mail window collects the callback the host is holding. */
export const MAIL_PENDING_CALLBACK_ROUTE = route(MAIL_PENDING_CALLBACK_PATH);
