// Throwaway model: GitHub observations and connection authorization are simulated.
export type Connection = {
	principal: string;
	isConnected: boolean;
	repositoryIds: number[];
};

export type Pairing = { folder: string; repositoryId: number };
export type Repository = { id: number; url: string; isPrivate: boolean };

export function authorizeTransfer(
	connection: Connection,
	pairing: Pairing,
	repository: Repository,
	request: { principal: string; origin: string },
) {
	if (request.principal !== connection.principal)
		return 'Wrong Epicenter account';
	if (!connection.isConnected) return 'GitHub disconnected';
	if (pairing.repositoryId !== repository.id) return 'Repository was replaced';
	if (!repository.isPrivate) return 'Repository is no longer private';
	if (!connection.repositoryIds.includes(repository.id))
		return 'Installation lacks access';
	if (request.origin !== repository.url) return 'Origin needs explicit review';
	return 'Allowed';
}
