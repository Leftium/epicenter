import type { BetterAuthSessionResponse } from '@epicenter/auth/contracts';
import type { EncryptionKeys } from '@epicenter/encryption';
import type { Session, User } from 'better-auth';

export async function createBetterAuthSessionResponse(
	{ user, session }: { user: User; session: Session },
	{
		deriveUserEncryptionKeys,
	}: { deriveUserEncryptionKeys: (userId: string) => Promise<EncryptionKeys> },
): Promise<BetterAuthSessionResponse> {
	const encryptionKeys = await deriveUserEncryptionKeys(user.id);
	return {
		user,
		session,
		encryptionKeys,
	} satisfies BetterAuthSessionResponse;
}
