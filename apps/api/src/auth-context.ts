import { AsyncLocalStorage } from "node:async_hooks";

export interface AuthenticatedUserContext {
  userId: string;
  accessToken: string;
  email?: string;
}

const userContext = new AsyncLocalStorage<AuthenticatedUserContext>();
const researchOwnerContext = new AsyncLocalStorage<string>();

export function withAuthenticatedUser<T>(
  identity: AuthenticatedUserContext,
  operation: () => T,
): T {
  return userContext.run(identity, operation);
}

export function currentAuthenticatedUser(): AuthenticatedUserContext | undefined {
  return userContext.getStore();
}

/** Internal worker-only ownership context; it carries no user-supplied identity or token. */
export function withResearchOwner<T>(ownerId: string, operation: () => T): T {
  return researchOwnerContext.run(ownerId, operation);
}

export function currentResearchOwnerId(): string | undefined {
  return researchOwnerContext.getStore();
}
