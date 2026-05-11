import { AuthUser } from '@epicenter/auth';
import type { AuthSessionResponse } from '@epicenter/auth/contracts';
import type { EncryptionKeys } from '@epicenter/encryption';
import type { User } from 'better-auth';

export async function createAuthSessionResponse(
	{ user }: { user: User },
	{
		deriveUserEncryptionKeys,
	}: { deriveUserEncryptionKeys: (userId: string) => Promise<EncryptionKeys> },
): Promise<AuthSessionResponse> {
	const encryptionKeys = await deriveUserEncryptionKeys(user.id);
	return {
		user: AuthUser.assert(user),
		encryptionKeys,
	} satisfies AuthSessionResponse;
}
