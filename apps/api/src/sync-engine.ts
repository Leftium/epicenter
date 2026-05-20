import { MAX_PAYLOAD_BYTES } from './constants';
import type { DispatchResult, DispatchRpcRequest, Room } from './room';

export type SyncRooms = {
	get(roomName: string): SyncRoom;
};

export type SyncRoom = {
	fetch(request: Request): Promise<Response>;
	sync(body: Uint8Array): Promise<{
		diff: Uint8Array | null;
		storageBytes: number;
	}>;
	getDoc(): Promise<{ data: Uint8Array; storageBytes: number }>;
	dispatch(request: DispatchRpcRequest): Promise<DispatchResult>;
};

export function cloudflareDurableObjectRooms(
	roomNamespace: DurableObjectNamespace<Room>,
): SyncRooms {
	return {
		get(roomName) {
			return roomNamespace.get(roomNamespace.idFromName(roomName));
		},
	};
}

export function createSyncEngine(
	{
		rooms,
	}: {
		rooms: SyncRooms;
	},
	options?: {
		maxPayloadBytes?: number;
	},
) {
	const maxPayloadBytes = options?.maxPayloadBytes ?? MAX_PAYLOAD_BYTES;

	return {
		async handleWebSocket(
			request: Request,
			input: {
				roomName: string;
			},
		): Promise<Response> {
			return rooms.get(input.roomName).fetch(request);
		},

		async handleHttpSync(
			request: Request,
			input: {
				roomName: string;
			},
		): Promise<{
			response: Response;
			storageBytes: number | null;
		}> {
			const body = new Uint8Array(await request.arrayBuffer());
			if (body.byteLength > maxPayloadBytes) {
				return {
					response: new Response('Payload too large', { status: 413 }),
					storageBytes: null,
				};
			}

			const { diff, storageBytes } = await rooms.get(input.roomName).sync(body);

			return {
				response: diff
					? binaryResponse(diff)
					: new Response(null, { status: 204 }),
				storageBytes,
			};
		},

		async getSnapshot(roomName: string): Promise<{
			response: Response;
			storageBytes: number;
		}> {
			const { data, storageBytes } = await rooms.get(roomName).getDoc();
			return { response: binaryResponse(data), storageBytes };
		},

		async dispatch(
			roomName: string,
			request: DispatchRpcRequest,
		): Promise<DispatchResult> {
			return rooms.get(roomName).dispatch(request);
		},
	};
}

/**
 * Wrap a Uint8Array in a Response with a fresh ArrayBuffer copy.
 *
 * Yjs encoders return Uint8Array views that may share a larger internal
 * backing buffer. The copy isolates exactly the bytes that should be sent.
 */
function binaryResponse(data: Uint8Array): Response {
	const body = new ArrayBuffer(data.byteLength);
	new Uint8Array(body).set(data);
	return new Response(body, {
		headers: { 'content-type': 'application/octet-stream' },
	});
}
