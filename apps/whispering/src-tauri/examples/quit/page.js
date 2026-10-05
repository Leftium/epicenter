// The fixture page of `examples/quit`: a page-like voter, not Whispering's
// page. The real Bun host serves it in place of the built page, so it runs in
// the main window on the host's origin, with that window's real Tauri IPC and
// capability and the bridge credential the shell gives the host's page.
//
// It hears the shell's close question the way `src/lib/workspace/closing.ts`
// does, on the host's event stream, and answers it the way the desktop
// workspace does, with `POST /bridge/app { op: "close" }`. With the host gone
// it hears the shell's `whispering:close-blocked` event and quits through the
// quit address, as `quitWithoutHost` does.
//
// It answers the first question with `cancel` ("Keep working") and the next
// with `proceed`. Unlike Whispering's page, it approves without settling its
// saves first, so a save it started is still running when the shell exits:
// that is what the harness checks the folder's owner drains.
//
// It reports through the folder itself, under `harness/`. `__SCOPE__`,
// `__PROTOCOL__`, and `__SCENARIO__` are filled in by the harness.
(async () => {
	const internals = window.__TAURI_INTERNALS__;
	const invoke = (command, args) => internals.invoke(command, args);
	const origin = window.location.origin;
	const authorization = `Bearer ${window.__WHISPERING_BRIDGE__.token}`;
	const scenario = '__SCENARIO__';
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

	const answer = async (decision) => {
		const response = await fetch(`${origin}/bridge/app`, {
			method: 'POST',
			headers: { authorization, 'content-type': 'application/json' },
			body: JSON.stringify({ op: 'close', payload: { decision } }),
		});
		if (!response.ok) throw new Error(`close ${decision}: ${response.status}`);
	};

	let asked = 0;
	const closeRequested = async () => {
		asked += 1;
		if (asked === 1) {
			await answer('cancel');
			await report('declined', { asked });
		} else {
			await answer('proceed');
		}
	};

	let blocked = 0;
	window.addEventListener('whispering:close-blocked', () => {
		blocked += 1;
		if (blocked === 1) void report('blocked', { blocked });
		else window.location.assign(`${origin}/__whispering__/quit`);
	});

	// The host's event stream: one JSON line per event. The host repeats a
	// question nobody has answered to every stream that connects, so one asked
	// before this connects is not lost.
	void (async () => {
		const decoder = new TextDecoder();
		let pending = '';
		try {
			const events = await fetch(`${origin}/bridge/events`, {
				headers: { authorization },
			});
			if (!events.ok) throw new Error(`events: ${events.status}`);
			const reader = events.body.getReader();
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return;
				pending += decoder.decode(value, { stream: true });
				let newline = pending.indexOf('\n');
				while (newline >= 0) {
					const line = pending.slice(0, newline).trim();
					pending = pending.slice(newline + 1);
					if (line !== '' && JSON.parse(line).type === 'close-requested')
						void closeRequested();
					newline = pending.indexOf('\n');
				}
			}
		} catch {
			// The host is gone; the shell's page event is the question now.
		}
	})();

	const attached = await invoke('plugin:epicenter-folder|attach', {
		scope: '__SCOPE__',
		protocol: __PROTOCOL__,
	});
	session = attached.session;

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
	await report('ready', {
		scenario,
		root: attached.root,
		port: Number(window.location.port),
	});
})();
