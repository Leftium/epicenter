import { redirect } from '@sveltejs/kit';
import { auth } from '$lib/auth';

export async function load() {
	await auth.whenReady;
	if (auth.identity) redirect(307, '/');
	return {};
}
