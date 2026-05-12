import { type WorkspaceIdentity, AuthUser } from '@epicenter/auth';
import type { EncryptionKeys } from '@epicenter/encryption';
import type { User } from 'better-auth';

export async function createWorkspaceIdentityResponse(
	{ user }: { user: User },
	{
		deriveUserEncryptionKeys,
	}: { deriveUserEncryptionKeys: (userId: string) => Promise<EncryptionKeys> },
): Promise<WorkspaceIdentity> {
	const encryptionKeys = await deriveUserEncryptionKeys(user.id);
	return {
		user: AuthUser.assert(user),
		encryptionKeys,
	} satisfies WorkspaceIdentity;
}
