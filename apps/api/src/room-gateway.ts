import type { DispatchRpcRequest, Room } from './room';

export function cloudflareDurableObjectRooms(
	roomNamespace: DurableObjectNamespace<Room>,
) {
	const getRoom = (roomName: string) =>
		roomNamespace.get(roomNamespace.idFromName(roomName));

	return {
		handleWebSocket(roomName: string, request: Request) {
			return getRoom(roomName).fetch(request);
		},
		sync(roomName: string, body: Uint8Array) {
			return getRoom(roomName).sync(body);
		},
		getDoc(roomName: string) {
			return getRoom(roomName).getDoc();
		},
		dispatch(roomName: string, request: DispatchRpcRequest) {
			return getRoom(roomName).dispatch(request);
		},
	};
}
