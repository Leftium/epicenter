import type { AuthSessionResponse } from '@epicenter/auth/contracts';
import type { Session, User } from 'better-auth';
import { verifyAccessToken } from 'better-auth/oauth2';

type SessionWithUser = {
	session: Session;
	user: User;
};

type ResolveOAuthBearerSessionResult =
	| {
			status: 'resolved';
			body: AuthSessionResponse;
			sessionToken: string;
	  }
	| { status: 'malformed' }
	| { status: 'invalid' };

export async function resolveOAuthBearerSession({
	authorization,
	baseURL,
	findSessionWithUserById,
	createSessionResponse,
	verifyOAuthAccessToken = verifyAccessToken,
}: {
	authorization: string | null;
	baseURL: string;
	findSessionWithUserById(sessionId: string): Promise<SessionWithUser | null>;
	createSessionResponse(
		input: SessionWithUser,
	): Promise<AuthSessionResponse>;
	verifyOAuthAccessToken?: typeof verifyAccessToken;
}): Promise<ResolveOAuthBearerSessionResult> {
	const accessToken = parseBearer(authorization);
	if (!accessToken) return { status: 'malformed' };

	// This endpoint is the resource-server boundary. OAuth access tokens prove
	// a client grant, then `sid` links back to the durable Better Auth session.
	const payload = await verifyOAuthAccessToken(accessToken, {
		jwksUrl: `${baseURL}/auth/jwks`,
		verifyOptions: {
			audience: baseURL,
			issuer: `${baseURL}/auth`,
		},
	}).catch(() => null);
	const sessionId = typeof payload?.sid === 'string' ? payload.sid : null;
	if (!sessionId) return { status: 'invalid' };

	const sessionWithUser = await findSessionWithUserById(sessionId);
	if (!sessionWithUser) return { status: 'invalid' };
	if (new Date(sessionWithUser.session.expiresAt).getTime() <= Date.now()) {
		return { status: 'invalid' };
	}

	return {
		status: 'resolved',
		body: await createSessionResponse(sessionWithUser),
		sessionToken: sessionWithUser.session.token,
	};
}

function parseBearer(value: string | null): string | null {
	if (!value) return null;
	const match = value.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || null;
}
