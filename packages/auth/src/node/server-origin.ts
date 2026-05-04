export function normalizeServerOrigin(input: string | URL): string {
	const raw = String(input)
		.replace(/^wss:/, 'https:')
		.replace(/^ws:/, 'http:');
	const url = new URL(raw);

	if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
		throw new Error('Expected a server origin like https://api.epicenter.so.');
	}

	return url.origin;
}
