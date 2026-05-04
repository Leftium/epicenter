import { EncryptionKeys } from '@epicenter/encryption';
import type {
	User as BetterAuthUser,
	Session as BetterSession,
} from 'better-auth';

export type BetterAuthSessionResponse = {
	user: BetterAuthUser;
	session: BetterSession;
	encryptionKeys: EncryptionKeys;
};
