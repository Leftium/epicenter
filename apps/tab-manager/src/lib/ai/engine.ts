/**
 * BGSW chat engine — runs `chat()` from TanStack AI directly in the
 * background service worker.
 *
 * This replaces the hub server's AI plugin for tab-manager-specific chat.
 * Instead of streaming through SSE via the hub, the engine:
 * 1. Creates a provider adapter (BYOK or via hub proxy)
 * 2. Binds read tools (query Y.Doc) and mutation tools (call Chrome APIs)
 * 3. Calls `chat()` which streams AG-UI protocol events
 * 4. Writes assistant messages progressively to Y.Doc chatMessages table
 * 5. Side panel observes Y.Doc changes via BroadcastChannel (sub-ms sync)
 *
 * @example
 * ```typescript
 * const engine = createChatEngine({
 *   tables: client.tables,
 *   deviceId,
 * });
 *
 * await engine.handleChatRequest({
 *   conversationId: 'conv-123',
 *   messages: [...],
 *   provider: 'anthropic',
 *   model: 'claude-sonnet-4-20250514',
 *   apiKey: 'sk-ant-...',
 * });
 * ```
 */

import type { TableHelper } from '@epicenter/hq';
import { generateId } from '@epicenter/hq';
import { chat, maxIterations } from '@tanstack/ai';
import type {
	ChatMessage,
	ChatMessageId,
	Conversation,
	ConversationId,
	Device,
	DeviceId,
	SavedTab,
	Tab,
	Window,
} from '$lib/workspace';
import { createBgswAdapter, isSupportedProvider } from './adapters';
import { createMutationTools } from './tools/mutation-tools';
import { createReadTools } from './tools/read-tools';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Tables required by the chat engine. */
type EngineTables = {
	tabs: TableHelper<Tab>;
	windows: TableHelper<Window>;
	devices: TableHelper<Device>;
	savedTabs: TableHelper<SavedTab>;
	chatMessages: TableHelper<ChatMessage>;
	conversations: TableHelper<Conversation>;
};

/** Configuration for creating the chat engine. */
export type ChatEngineConfig = {
	/** Workspace table helpers from the BGSW's client. */
	tables: EngineTables;
	/** This device's ID. */
	deviceId: DeviceId;
};

/**
 * A chat request from the side panel.
 *
 * Sent via `chrome.runtime.sendMessage` and received by the BGSW's
 * `chrome.runtime.onMessage` handler.
 */
export type ChatRequest = {
	type: 'chat';
	conversationId: ConversationId;
	/** TanStack AI UIMessage array (already persisted in Y.Doc by the side panel). */
	messages: unknown[];
	provider: string;
	model: string;
	/** BYOK API key, or undefined if using operator proxy. */
	apiKey?: string;
	/** System prompt override from conversation settings. */
	systemPrompt?: string;
	/** Hub server URL for operator proxy mode. */
	hubServerUrl?: string;
};

/** Response sent back to the side panel via sendResponse or BroadcastChannel. */
export type ChatResponse =
	| { type: 'started'; messageId: string }
	| { type: 'error'; message: string }
	| { type: 'complete' };

// ─────────────────────────────────────────────────────────────────────────────
// System Prompt
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a helpful browser tab manager assistant. You can search, list, organize, and manage browser tabs across the user's devices.

Available capabilities:
- Search and list tabs, windows, and devices across all synced browsers
- Close, open, activate, pin, mute, group, save, and reload tabs
- Aggregate tab counts by domain

Guidelines:
- When the user asks to close/manage tabs, use searchTabs first to find the right ones
- When a device is ambiguous, use listDevices to show options and ask the user
- Tab IDs are composite (deviceId_tabId) — always use the full composite ID from search results
- For mutations, all tabs in a single command must belong to the same device
- Be concise in responses — confirm what you did, don't over-explain`;

// ─────────────────────────────────────────────────────────────────────────────
// Engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a BGSW chat engine.
 *
 * The engine is long-lived — created once during BGSW initialization and
 * reused for all chat requests. It holds references to the workspace tables
 * and device ID, creating fresh adapters per-request (since provider/model
 * can change between conversations).
 */
export function createChatEngine(config: ChatEngineConfig) {
	const { tables, deviceId } = config;

	// Build tools once — they're bound to the tables and deviceId, which don't change.
	const readTools = createReadTools({
		tabs: tables.tabs,
		windows: tables.windows,
		devices: tables.devices,
	});
	const mutationTools = createMutationTools({
		deviceId,
		savedTabsTable: tables.savedTabs,
	});
	const tools = [...readTools, ...mutationTools];

	return {
		/**
		 * Handle a chat request from the side panel.
		 *
		 * Creates a fresh adapter for the request's provider/model, runs
		 * `chat()` with all tools, and writes the assistant response
		 * progressively to Y.Doc. The side panel observes these writes
		 * via BroadcastChannel for sub-ms streaming updates.
		 *
		 * @returns A ChatResponse indicating success or failure.
		 */
		async handleChatRequest(request: ChatRequest): Promise<ChatResponse> {
			const {
				conversationId,
				messages,
				provider,
				model,
				apiKey,
				systemPrompt,
				hubServerUrl,
			} = request;

			// Validate provider
			if (!isSupportedProvider(provider)) {
				return { type: 'error', message: `Unsupported provider: ${provider}` };
			}

			// Resolve API key and adapter options
			if (!apiKey && !hubServerUrl) {
				return {
					type: 'error',
					message:
						'No API key configured. Add a key in settings or configure a hub server.',
				};
			}

			const adapter = createBgswAdapter(provider, model, {
				apiKey: apiKey ?? 'proxy-session',
				baseURL:
					!apiKey && hubServerUrl
						? `${hubServerUrl}/proxy/${provider}`
						: undefined,
			});

			if (!adapter) {
				return { type: 'error', message: `Unsupported provider: ${provider}` };
			}

			// Generate the assistant message ID upfront so we can write progressively
			const assistantMessageId = generateId() as string as ChatMessageId;

			try {
				// Run chat() — this streams AG-UI protocol events
				const stream = chat({
					adapter,
					messages: messages as Parameters<typeof chat>[0]['messages'],
					conversationId,
					tools,
					agentLoopStrategy: maxIterations(10),
					systemPrompts: [
						SYSTEM_PROMPT,
						...(systemPrompt ? [systemPrompt] : []),
					],
				});

				// Consume the stream and accumulate the response
				let accumulatedText = '';
				const toolCallParts: unknown[] = [];

				for await (const chunk of stream) {
					switch (chunk.type) {
						case 'TEXT_MESSAGE_CONTENT':
							accumulatedText =
								chunk.content ?? accumulatedText + (chunk.delta ?? '');
							// Progressive write to Y.Doc — side panel sees this instantly via BroadcastChannel
							tables.chatMessages.set({
								id: assistantMessageId,
								conversationId,
								role: 'assistant',
								parts: [
									{ type: 'text', content: accumulatedText },
									...toolCallParts,
								],
								createdAt: Date.now(),
								_v: 1,
							});
							break;

						case 'TOOL_CALL_START':
							toolCallParts.push({
								type: 'tool-call',
								toolCallId: chunk.toolCallId,
								toolName: chunk.toolName,
								args: {},
								state: 'calling',
							});
							break;

						case 'TOOL_CALL_END':
							// Update the tool call part to reflect completion
							for (const part of toolCallParts) {
								const p = part as Record<string, unknown>;
								if (p.toolCallId === chunk.toolCallId) {
									p.args = chunk.input ?? {};
									p.state = 'result';
								}
							}
							break;

						case 'RUN_ERROR':
							return {
								type: 'error',
								message: chunk.error?.message ?? 'Unknown error during chat',
							};
					}
				}

				// Final write with complete message (ensures onFinish-equivalent persistence)
				if (accumulatedText || toolCallParts.length > 0) {
					const parts: unknown[] = [];
					if (accumulatedText) {
						parts.push({ type: 'text', content: accumulatedText });
					}
					parts.push(...toolCallParts);

					tables.chatMessages.set({
						id: assistantMessageId,
						conversationId,
						role: 'assistant',
						parts,
						createdAt: Date.now(),
						_v: 1,
					});
				}

				// Touch conversation's updatedAt so it floats to top
				const conv = tables.conversations.get(conversationId);
				if (conv.status === 'valid') {
					tables.conversations.set({
						...conv.row,
						updatedAt: Date.now(),
					});
				}

				return { type: 'complete' };
			} catch (error) {
				const message =
					error instanceof Error ? error.message : 'Unknown error';
				return { type: 'error', message };
			}
		},
	};
}
