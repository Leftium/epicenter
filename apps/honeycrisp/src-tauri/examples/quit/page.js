// The fixture page of `examples/quit`: a page-like voter, not the notes page.
// The harness evaluates this in the notes window once the page loaded; it
// runs with that window's real IPC, capability, and folder scope.
//
// It keeps the production page's order (`src/lib/platform/shell.tauri.ts`):
// register, listen for close requests, attach the folder, then say the folder
// is open. It answers the first close request with "keep editing" and every
// later one with an approval. Unlike the notes page, it approves without
// settling its saves first, so a save it started is still running when the
// shell exits: that is what the harness checks the folder plugin drains.
//
// It reports through the folder itself, under `harness/`, because the
// window's capability lets it emit nothing else. `__SCOPE__` and
// `__PROTOCOL__` are filled in by the harness.
(async () => {
	const internals = window.__TAURI_INTERNALS__;
	const invoke = (command, args) => internals.invoke(command, args);
	const bytes = (text) => Array.from(new TextEncoder().encode(text));
	let session;
	const apply = (changes) =>
		invoke('plugin:epicenter-folder|apply', {
			session,
			changes,
		});
	const report = (name, value) =>
		apply([
			{
				kind: 'overwrite',
				path: `harness/${name}.json`,
				bytes: bytes(JSON.stringify(value)),
			},
		]);

	const generation = await invoke('close_register');
	const answered = new Set();
	const handler = internals.transformCallback(async ({ payload }) => {
		// The shell repeats an unanswered request; each is answered once.
		if (payload.generation !== generation || answered.has(payload.request))
			return;
		answered.add(payload.request);
		const ask = { generation, request: payload.request };
		if (answered.size === 1) {
			await invoke('close_decline', ask);
			await report('declined', ask);
		} else {
			await invoke('close_approve', ask);
		}
	});
	await invoke('plugin:event|listen', {
		event: 'close-requested',
		target: { kind: 'Any' },
		handler,
	});
	const attached = await invoke('plugin:epicenter-folder|attach', {
		scope: '__SCOPE__',
		protocol: __PROTOCOL__,
	});
	session = attached.session;
	await invoke('close_opened', { generation });

	window.__quitFixture = {
		// One batch of `count` new files, sent and not awaited: the owner admits
		// it as one operation and writes the files in order.
		startBatch(count) {
			const changes = [];
			for (let index = 0; index < count; index += 1)
				changes.push({
					kind: 'create',
					path: `batch/${String(index).padStart(6, '0')}.md`,
					bytes: bytes(`${index}\n`),
				});
			apply(changes).catch(() => {});
		},
	};
	await report('ready', { generation, root: attached.root });
})();
