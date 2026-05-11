import { type AuthIdentity, AuthUser } from '@epicenter/auth';
import type { EncryptionKeys } from '@epicenter/encryption';
import type { User } from 'better-auth';

export async function createAuthIdentityResponse(
	{ user }: { user: User },
	{
		deriveUserEncryptionKeys,
	}: { deriveUserEncryptionKeys: (userId: string) => Promise<EncryptionKeys> },
): Promise<AuthIdentity> {
	const encryptionKeys = await deriveUserEncryptionKeys(user.id);
	return {
		user: AuthUser.assert(user),
		encryptionKeys,
	} satisfies AuthIdentity;
}
