/**
 * Token verification function for sync auth.
 *
 * - Omit entirely for open mode (no auth, any client connects)
 * - Provide a function to verify tokens (e.g. JWT validation, session lookup)
 */
export type VerifyToken = (token: string) => boolean | Promise<boolean>;
