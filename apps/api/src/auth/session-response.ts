import {
	type AuthSessionResponse,
	authUserFromBetterAuthUser,
} from '@epicenter/auth/contracts';
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
		user: authUserFromBetterAuthUser(user),
		encryptionKeys,
	} satisfies AuthSessionResponse;
}
