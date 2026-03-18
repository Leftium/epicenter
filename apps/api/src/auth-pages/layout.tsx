import type { Child } from 'hono/jsx';
import { AUTH_STYLES } from './styles';

/**
 * Shared HTML shell for all auth pages (sign-in, consent, device).
 *
 * Renders the full `<!DOCTYPE html>` document with viewport meta, the shared
 * CSS, and a centered card wrapper. Each page component is passed as `children`.
 */
export function AuthLayout({
	title,
	children,
}: {
	title: string;
	children: Child;
}) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>{title}</title>
				<style>{AUTH_STYLES}</style>
			</head>
			<body>
				<div class="card">{children}</div>
			</body>
		</html>
	);
}
