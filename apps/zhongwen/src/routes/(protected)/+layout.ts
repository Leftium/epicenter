import { redirect } from '@sveltejs/kit';
import { auth } from '$lib/auth';

export async function load() {
	await auth.whenReady;

	const { identity } = auth;
	if (!identity) redirect(307, '/sign-in');

	return { identity };
}
