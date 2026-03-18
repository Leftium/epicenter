/**
 * Render functions for auth pages.
 *
 * Each function returns the full JSX tree (layout + page) ready to be
 * passed to `c.html()` in a Hono route handler. This keeps JSX contained
 * in `.tsx` files so `app.ts` doesn't need renaming.
 */

import { ConsentPage } from './consent-page';
import { DevicePage } from './device-page';
import { AuthLayout } from './layout';
import { SignInPage } from './sign-in-page';

export function renderSignInPage() {
	return (
		<AuthLayout title="Sign in — Epicenter">
			<SignInPage />
		</AuthLayout>
	);
}

export function renderConsentPage({
	consentCode,
	clientId,
	scope,
}: {
	consentCode?: string;
	clientId?: string;
	scope?: string;
}) {
	return (
		<AuthLayout title="Authorize — Epicenter">
			<ConsentPage
				consentCode={consentCode}
				clientId={clientId}
				scope={scope}
			/>
		</AuthLayout>
	);
}

export function renderDevicePage({ userCode }: { userCode?: string }) {
	return (
		<AuthLayout title="Authorize Device — Epicenter">
			<DevicePage userCode={userCode} />
		</AuthLayout>
	);
}
