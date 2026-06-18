/**
 * The inference backend as a single `ChatStream` (S5). With `GEMINI_API_KEY`
 * set, this is real Gemini, built exactly as `apps/zhongwen/mount.ts` builds it
 * (`createGeminiChat` + `chat({ adapter, messages, abortController })`). With no
 * key it falls back to a slow echo so S1-S4 run with zero setup.
 *
 * Swapping real inference in is this one function, not a rewrite: the actor's
 * append loop is identical either way (`startStream(messages, signal)`).
 */

import type { ChatStream } from '@epicenter/workspace/ai';
import { chat, EventType, type StreamChunk } from '@tanstack/ai';
import { createGeminiChat } from '@tanstack/ai-gemini';

/**
 * Echo the last user message, one character at a time, slowly enough that you
 * can type `/cancel` mid-stream (S3). Honors the abort signal exactly like a
 * real backend must, so the durable-cancel path is real, not simulated.
 */
const echoStream: ChatStream = async function* (messages, signal) {
	const last = messages[messages.length - 1];
	const said =
		typeof last?.content === 'string'
			? last.content
			: JSON.stringify(last?.content ?? '');
	const reply = `You said: "${said}". This is the demo actor streaming an echo through the synced doc, one character at a time, slowly enough that you can type /cancel mid-stream to exercise the durable, offline-survivable cancel path.`;
	for (const char of reply) {
		if (signal.aborted) return;
		yield {
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: 'echo',
			delta: char,
		} as StreamChunk;
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
};

/** Pick the backend once: real Gemini if keyed, otherwise the echo. */
export function resolveChatStream(): ChatStream {
	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) {
		console.log('(no GEMINI_API_KEY — using the echo stream)');
		return echoStream;
	}
	const model = (process.env.GEMINI_MODEL ??
		'gemini-3.5-flash') as Parameters<typeof createGeminiChat>[0];
	console.log(`(GEMINI_API_KEY set — real inference via ${model})`);
	const adapter = createGeminiChat(model, apiKey);
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
			systemPrompts: ['You are a concise, friendly demo assistant.'],
			abortController,
		});
	};
}
