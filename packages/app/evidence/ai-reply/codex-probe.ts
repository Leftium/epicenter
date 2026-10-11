/** Real Codex process with a local Responses fixture: no account inference or model credits. */
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unwrap } from 'wellcrafted/result';
import { createCodexAi } from '../../src/codex-ai.js';
import { openCodexConnection } from '../../src/codex-connection.js';
import type { ReplyEvent } from '../../src/reply.js';

const executable = process.argv[2] ?? 'codex';
const directory = await mkdtemp(join(tmpdir(), 'epicenter-codex-probe-'));
const certificate = join(directory, 'certificate.pem');
const key = join(directory, 'key.pem');
const rootCertificate = join(directory, 'root.pem');
const rootKey = join(directory, 'root-key.pem');
const csr = join(directory, 'server.csr');
const extensions = join(directory, 'extensions.cnf');
await Bun.write(
	extensions,
	'basicConstraints=CA:FALSE\nsubjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n',
);
for (const args of [
	[
		'req',
		'-x509',
		'-newkey',
		'rsa:2048',
		'-nodes',
		'-keyout',
		rootKey,
		'-out',
		rootCertificate,
		'-days',
		'1',
		'-subj',
		'/CN=Epicenter probe CA',
	],
	[
		'req',
		'-newkey',
		'rsa:2048',
		'-nodes',
		'-keyout',
		key,
		'-out',
		csr,
		'-subj',
		'/CN=localhost',
	],
	[
		'x509',
		'-req',
		'-in',
		csr,
		'-CA',
		rootCertificate,
		'-CAkey',
		rootKey,
		'-CAcreateserial',
		'-out',
		certificate,
		'-days',
		'1',
		'-extfile',
		extensions,
	],
]) {
	const openssl = Bun.spawn(['openssl', ...args], {
		stdout: 'ignore',
		stderr: 'ignore',
	});
	assert.equal(await openssl.exited, 0);
}
const requests: Record<string, unknown>[] = [];
const cancellationStarted = Promise.withResolvers<void>();
const server = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	tls: { cert: Bun.file(certificate), key: Bun.file(key) },
	async fetch(request) {
		const pathname = new URL(request.url).pathname;
		if (request.headers.get('upgrade') === 'websocket')
			return new Response(null, { status: 426 });

		if (pathname.endsWith('/accounts/check')) {
			const selected = request.headers.get('chatgpt-account-id');
			return Response.json({
				accounts: [
					{
						id: selected,
						workspace_backend_origin: new URL(request.url).origin,
						account_routing_override: 'NO_CONSTRAINT',
					},
				],
				default_account_id: selected,
			});
		}
		if (pathname.endsWith('/config/bundle')) return Response.json({});
		if (!pathname.endsWith('/responses')) return Response.json({ models: [] });
		const body = (await request.json()) as Record<string, unknown>;
		requests.push(body);
		if (requests.length === 3) {
			cancellationStarted.resolve();
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'event: response.created\ndata: {"type":"response.created","response":{"id":"waiting","status":"in_progress","output":[]}}\n\n',
							),
						);
					},
				}),
				{ headers: { 'content-type': 'text/event-stream' } },
			);
		}
		const item = {
			id: `message-${requests.length}`,
			type: 'message',
			role: 'assistant',
			phase: 'final_answer',
			status: 'completed',
			content: [
				{ type: 'output_text', text: 'Canonical answer', annotations: [] },
			],
		};
		const events = [
			{
				type: 'response.created',
				response: {
					id: 'response',
					object: 'response',
					status: 'in_progress',
					output: [],
				},
			},
			{
				type: 'response.output_item.added',
				output_index: 0,
				item: { ...item, status: 'in_progress', content: [] },
			},
			{
				type: 'response.output_text.delta',
				output_index: 0,
				content_index: 0,
				item_id: item.id,
				delta: 'Canonical answer',
			},
			{ type: 'response.output_item.done', output_index: 0, item },
			{
				type: 'response.completed',
				response: {
					id: 'response',
					object: 'response',
					status: 'completed',
					output: [item],
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				},
			},
		];
		return new Response(
			events
				.map(
					(event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
				)
				.join(''),
			{ headers: { 'content-type': 'text/event-stream' } },
		);
	},
});
const wrapper = join(directory, 'codex');
const diagnostic = join(directory, 'stderr.txt');
const providerId = process.argv[3] ?? 'openai';
assert(['openai', 'epicenter_probe'].includes(providerId));
const provider = `{name="OpenAI",base_url="https://127.0.0.1:${server.port}/v1",wire_api="responses",requires_openai_auth=false}`;
await Bun.write(
	wrapper,
	`#!${process.execPath}
const args=process.argv.slice(2);
const extra=args.includes('--version')?[]:['-c','features.enable_request_compression=false','-c','features.responses_websockets=false','-c','features.responses_websockets_v2=false','-c',${JSON.stringify(`model_provider="${providerId}"`)},...(${JSON.stringify(providerId)}==='openai'?['-c',${JSON.stringify(`openai_base_url="https://127.0.0.1:${server.port}/v1"`)}]:['-c',${JSON.stringify(`model_providers.${providerId}=${provider}`)}]),'-c',${JSON.stringify(`chatgpt_base_url="https://127.0.0.1:${server.port}/v1"`)}];
const child=Bun.spawn([${JSON.stringify(executable)},...args,...extra],{stdin:'inherit',stdout:'inherit',stderr:'pipe',env:{...process.env,SSL_CERT_FILE:${JSON.stringify(rootCertificate)},CODEX_CA_CERTIFICATE:${JSON.stringify(rootCertificate)}}});
const diagnostic=new Response(child.stderr).text();
process.on('SIGTERM',()=>child.kill());
const exit=await child.exited; await Bun.write(${JSON.stringify(diagnostic)},await diagnostic);process.exit(exit);
`,
);
await chmod(wrapper, 0o700);

let connection: Awaited<ReturnType<typeof openCodexConnection>> | undefined;
function answer(events: ReplyEvent[]) {
	const last = events.at(-1);
	assert(last?.type === 'result');
	return unwrap(last.result);
}
try {
	connection = await openCodexConnection({ executable: wrapper });
	const ai = createCodexAi(connection, { model: 'gpt-6.1-sol' });
	const request = {
		instructions: 'EPICENTER_TUTOR_INSTRUCTIONS',
		messages: [],
		signal: AbortSignal.timeout(20_000),
	};
	assert.equal(
		answer(await Array.fromAsync(ai.reply(request))),
		'Canonical answer',
	);
	assert.equal(
		answer(
			await Array.fromAsync(
				ai.reply({
					...request,
					messages: [
						{ role: 'user', content: 'EPICENTER_SAVED_USER' },
						{ role: 'assistant', content: 'EPICENTER_SAVED_ASSISTANT' },
					],
				}),
			),
		),
		'Canonical answer',
	);
	for (const body of requests) {
		assert.deepEqual(body.tools ?? [], []);
		const wire = JSON.stringify(body);
		assert(wire.includes('EPICENTER_TUTOR_INSTRUCTIONS'));
		assert(!wire.includes('<skills_instructions>'));
		assert(!wire.includes('<multi_agent_role>'));
	}
	const input = requests[1]!.input as { role?: string; content?: unknown }[];
	assert(
		input.some(
			(item) =>
				item.role === 'user' &&
				JSON.stringify(item.content).includes('EPICENTER_SAVED_USER'),
		),
	);
	assert(
		input.some(
			(item) =>
				item.role === 'assistant' &&
				JSON.stringify(item.content).includes('EPICENTER_SAVED_ASSISTANT'),
		),
	);
	assert(!JSON.stringify(requests[0]).includes('EPICENTER_SAVED_USER'));
	const controller = new AbortController();
	const iterator = ai.reply({ ...request, signal: controller.signal });
	const pending = iterator.next();
	await cancellationStarted.promise;
	controller.abort();
	const cancelled = (await pending).value;
	assert(cancelled?.type === 'result');
	assert.equal(cancelled.result.error?.name, 'Cancelled');
	assert.equal((await iterator.next()).done, true);
	await connection.close();
	console.log(
		`Verified real Codex (${providerId}): no tools/inherited skills, empty opening, exact roles, canonical completion, cancellation, and owner close.`,
	);
} catch (cause) {
	if (cause instanceof Error) console.error(cause.cause);
	if (await Bun.file(diagnostic).exists())
		console.error((await Bun.file(diagnostic).text()).slice(-2000));
	throw cause;
} finally {
	await connection?.close();
	server.stop(true);
	await rm(directory, { recursive: true, force: true });
}
