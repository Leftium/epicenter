/**
 * Zhongwen mount.
 *
 * `zhongwen()` returns the `Mount` that an `epicenter.config.ts`
 * default-exports. Zhongwen has no daemon actions to add and no materializers,
 * so the daemon hosts the root Y.Doc on disk and bridges cloud sync, then runs
 * one child-doc worker: an always-on observe loop (ADR-0024/0025) over the
 * `conversations.messages` transcripts. Registering the field is all the app
 * declares; the table, the guid, and the layout come from the schema. The
 * factory is the behavior seam, and it hands each hosted transcript to
 * `attachChatWorker`, the backend-agnostic append loop in
 * `@epicenter/workspace/ai`.
 *
 * The worker is parameterized by a `ChatStream`
 * (`startStream(messages, signal) => AsyncIterable<StreamChunk>`), the one
 * contract every inference backend speaks. The daemon builds the real one from
 * the same `chat()` call the hosted route makes ({@link resolveChatStream}): an
 * adapter for the configured `ZHONGWEN_MODEL` keyed on the matching provider key,
 * under the shared `ZHONGWEN_SYSTEM_PROMPT`. With no key it falls back to
 * {@link fakeChatStream},
 * a deterministic placeholder, and says so in the log: that fallback is the
 * explicit "real inference not wired on this host yet" boundary. The worker
 * itself observes -> answers -> streams -> finishes and honors the client's
 * durable cancel, all over hosted sync with no HTTP and no duplicate stream.
 *
 * Designation (R, ADR-0025) is the observe loop's concern, not this factory's:
 * the loop builds a worker only for conversations bound to this daemon's agent
 * (`row.agent === selfAgentId`), so the factory supplies behavior alone. The
 * `agentId` option names which catalog agent this daemon answers as (a
 * `ZHONGWEN_AGENTS` id like `zhongwen-home`); omit it and the daemon hosts
 * nothing, leaving every conversation to its bound agent. The browser nudges the
 * HTTP route only for cloud-runtime conversations, so a single turn is never
 * answered twice.
 */

import { createAdapterForModel } from '@epicenter/ai-adapters';
import { MODELS_BY_ID } from '@epicenter/constants/ai-providers';
import type { AgentId } from '@epicenter/workspace';
import { attachChatWorker, type ChatStream } from '@epicenter/workspace/ai';
import { nodeMountRuntime } from '@epicenter/workspace/node';
import {
	chat,
	EventType,
	type ModelMessage,
	type StreamChunk,
} from '@tanstack/ai';
import { createLogger } from 'wellcrafted/logger';
import {
	ZHONGWEN_MODEL,
	ZHONGWEN_SYSTEM_PROMPT,
	zhongwenWorkspace,
} from './zhongwen.js';

const log = createLogger('zhongwen/mount');

export type ZhongwenMountOptions = {
	/**
	 * Base URL of the Epicenter cloud API used for sync.
	 * Defaults to `process.env.EPICENTER_API_URL`, falling back to the hosted API.
	 */
	baseURL?: string;
	/**
	 * The catalog agent this daemon answers as (ADR-0025): a `ZHONGWEN_AGENTS` id
	 * such as `zhongwen-home`. The observe loop then hosts exactly the
	 * conversations bound to it. Omit it and the daemon hosts nothing.
	 */
	agentId?: AgentId;
};

export function zhongwen({ baseURL, agentId }: ZhongwenMountOptions = {}) {
	// Resolve the inference backend once: the adapter is built a single time and
	// the closure is shared across every hosted transcript.
	const startStream = resolveChatStream();
	return zhongwenWorkspace.mount({
		baseURL,
		agentId,
		runtime: nodeMountRuntime(),
		workers: {
			conversations: {
				messages: ({ ydoc }) => attachChatWorker({ ydoc, startStream }),
			},
		},
	});
}

/**
 * The daemon's inference backend as a {@link ChatStream}. The daemon answers as
 * whatever provider its `ZHONGWEN_MODEL` names: the catalog gives the provider,
 * and the matching house key (`OPENAI_API_KEY` / `GEMINI_API_KEY`) is read from
 * the environment. With that key set, this is real inference: an adapter (built
 * once via `createAdapterForModel`) driven by the same `chat()` call the hosted
 * route makes, under {@link ZHONGWEN_SYSTEM_PROMPT}. The worker hands a `signal`;
 * `chat()` cancels on an `AbortController`, so the signal is forwarded onto one.
 * With no key it returns the deterministic placeholder and logs that real
 * inference is not live on this host. Switching providers is a catalog + env-key
 * change, no code edit.
 */
function resolveChatStream(): ChatStream {
	// Key policy: the catalog gives the provider, the provider picks its house-key
	// env var (exhaustive, so a new provider is a compile error here, not a silent
	// wrong key). Construction is delegated to `@epicenter/ai-adapters`.
	const { provider } = MODELS_BY_ID[ZHONGWEN_MODEL];
	let envVar: 'OPENAI_API_KEY' | 'GEMINI_API_KEY';
	switch (provider) {
		case 'openai':
			envVar = 'OPENAI_API_KEY';
			break;
		case 'gemini':
			envVar = 'GEMINI_API_KEY';
			break;
		default:
			return provider satisfies never;
	}
	const apiKey = process.env[envVar];
	if (!apiKey) {
		log.warn(
			new Error(
				`${envVar} is not set; the Zhongwen daemon answers with the placeholder stream (real inference is not live on this host).`,
			),
		);
		return fakeChatStream;
	}
	const adapter = createAdapterForModel(ZHONGWEN_MODEL, apiKey);
	return (messages, signal) => {
		const abortController = new AbortController();
		if (signal.aborted) abortController.abort();
		else
			signal.addEventListener('abort', () => abortController.abort(), {
				once: true,
			});
		return chat({
			adapter,
			messages,
			systemPrompts: [ZHONGWEN_SYSTEM_PROMPT],
			abortController,
		});
	};
}

/**
 * A deterministic placeholder {@link ChatStream}: stream a fixed reply one
 * text-delta per word so the claim -> stream -> finish path is exercised end to
 * end without a provider. Used when the daemon has no provider key; real
 * inference is the same contract, so swapping it changes nothing downstream.
 */
const fakeChatStream: ChatStream = async function* (
	messages: ModelMessage[],
): AsyncGenerator<StreamChunk> {
	const userText = String(messages.at(-1)?.content ?? '');
	const reply = `Received: "${userText.trim()}". This is a placeholder reply streamed by the always-on worker; set the configured provider's API key for real inference.`;
	for (const token of reply.match(/\S+\s*/g) ?? [reply]) {
		yield {
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: 'fake',
			delta: token,
		} as StreamChunk;
		// Yield between tokens so each append is its own synced transaction and a
		// teardown or cancel abort can land between them.
		await Promise.resolve();
	}
};
