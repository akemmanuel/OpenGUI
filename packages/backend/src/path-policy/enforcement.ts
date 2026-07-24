import type {
  DurableActor,
  ExecutionPathAccess,
  ExecutionPolicy,
  ExecutionPolicyResolver,
} from "@opengui/harness";
import type { IdentityService } from "../identity/identity.ts";
import { canonicalizeAllowedRoots, createEffectivePathPolicy } from "./path-policy.ts";

export class PathAuthorizationError extends Error {
  readonly code = "PATH_NOT_AUTHORIZED";

  constructor(message = "Path not authorized") {
    super(message);
  }
}

/**
 * The single adapter from durable Harness/request attribution to current Host
 * identity. It deliberately fails closed for actorless, removed, and revoked
 * durable records.
 */
export function createEnforcedPolicyResolver(identity: IdentityService): ExecutionPolicyResolver {
  return async (durableActor) => {
    if (!durableActor) throw new PathAuthorizationError();
    const currentActor = await identity.resolveDurableActor(durableActor);
    if (!currentActor) throw new PathAuthorizationError();
    return await identity.effectivePathPolicy(currentActor);
  };
}

export function createLocalPolicyResolver(allowedRoots: string[]): ExecutionPolicyResolver {
  const canonicalRoots = canonicalizeAllowedRoots(allowedRoots);
  return async (actor) => {
    if (!actor || actor.type !== "local") throw new PathAuthorizationError();
    return createEffectivePathPolicy({
      revision: 0,
      restricted: false,
      allowedRoots: await canonicalRoots,
      grants: [],
    });
  };
}

export class HostPathAuthorizer {
  private readonly resolvePolicy?: ExecutionPolicyResolver;

  constructor(resolvePolicy?: ExecutionPolicyResolver) {
    this.resolvePolicy = resolvePolicy;
  }

  async policy(actor: DurableActor | undefined): Promise<ExecutionPolicy | null> {
    return this.resolvePolicy ? await this.resolvePolicy(actor) : null;
  }

  async authorizePath(
    actor: DurableActor | undefined,
    path: string,
    access: ExecutionPathAccess,
    options?: { allowMissingLeaf?: boolean },
  ) {
    const policy = await this.policy(actor);
    if (!policy) return path;
    const decision = await policy.authorizePath(path, access, options);
    if (!decision.allowed || !decision.canonicalPath) throw new PathAuthorizationError();
    return decision.canonicalPath;
  }

  async isRestricted(actor: DurableActor | undefined) {
    return (await this.policy(actor))?.restricted === true;
  }
}
