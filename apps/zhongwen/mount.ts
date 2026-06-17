/**
 * Zhongwen mount.
 *
 * `zhongwen()` returns the `Mount` that an `epicenter.config.ts`
 * default-exports. Zhongwen has no daemon actions to add and no materializers,
 * so the daemon hosts the root Y.Doc on disk and bridges cloud sync, then runs
 * one child-doc actor: an always-on observe loop (ADR-0012/0013) over the
 * `conversations.messages` transcripts. Registering the field is all the app
 * declares; the table, the guid, and the layout come from the schema. The
 * factory is the behavior seam, and it hands each hosted transcript to
 * `attachChatActor`, the backend-agnostic append loop in
 * `@epicenter/workspace/ai`.
 *
 * The actor is parameterized by a `ChatStream`
 * (`startStream(messages, signal) => AsyncIterable<StreamChunk>`), the one
 * contract every inference backend speaks. V0 injects {@link fakeChatStream}, a
 * deterministic placeholder reply; real cloud or local inference is a one-line
 * swap (V0.5),
 * once the daemon has an inference path. The actor itself observes -> answers ->
 * streams -> finishes and honors the client's durable cancel, all over hosted
 * sync with no HTTP and no duplicate stream.
 *
 * Designation (R, ADR-0013) is the observe loop's concern, not this factory's:
 * the loop builds an actor only for conversations designated to this daemon node
 * (`row.actorNodeId === selfNodeId`), so the factory supplies behavior alone. A
 * cloud-default conversation (`actorNodeId` null) is never hosted here and is left
 * to the cloud HTTP path; the browser also skips its kickoff for daemon-owned
 * conversations, so a single turn is never answered twice.
 */

import { attachChatActor, type ChatStream } from '@epicenter/workspace/ai';
import { nodeMountRuntime } from '@epicenter/workspace/node';
import { EventType, type ModelMessage, type StreamChunk } from '@tanstack/ai';
import { zhongwenWorkspace } from './zhongwen.js';

export type ZhongwenMountOptions = {
	/**
	 * Base URL of the Epicenter cloud API used for sync.
	 * Defaults to `process.env.EPICENTER_API_URL`, falling back to the hosted API.
	 */
	baseURL?: string;
};

export function zhongwen({ baseURL }: ZhongwenMountOptions = {}) {
	return zhongwenWorkspace.mount({
		baseURL,
		runtime: nodeMountRuntime(),
		actors: {
			conversations: {
				messages: ({ ydoc }) =>
					attachChatActor({ ydoc, startStream: fakeChatStream }),
			},
		},
	});
}

/**
 * A deterministic placeholder {@link ChatStream}: stream a fixed reply one
 * text-delta per word so the claim -> stream -> finish path is exercised end to
 * end without a provider. Real inference (a TanStack cloud adapter or a local
 * backend) is the same contract, so V0.5 swaps this argument and the append loop
 * is untouched.
 */
const fakeChatStream: ChatStream = async function* (
	messages: ModelMessage[],
): AsyncGenerator<StreamChunk> {
	const userText = String(messages.at(-1)?.content ?? '');
	const reply = `Received: "${userText.trim()}". This is a placeholder reply streamed by the always-on actor; real inference lands in V0.5.`;
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
