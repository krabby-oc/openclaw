import {
  getCanonicalGatewayContextResolver,
  getGatewayContextResolver,
  hasGatewayContextOwner,
} from "../plugins/runtime/gateway-request-scope.js";
import type { RpcSourceRef } from "../sessions/session-controller.rpc-sources.js";
import type { GatewayContextResolver } from "./server-methods/types.js";

export type SessionRuntimeScope = {
  storePath: string;
  resolveGatewayContext?: GatewayContextResolver;
};

/** Capture the Gateway binding, not the mutable context returned by its resolver. */
export function captureGatewayScopeMatcher(
  resolver: GatewayContextResolver | undefined,
): (owner: object) => boolean {
  const gatewayOwner = resolver && getCanonicalGatewayContextResolver(resolver);
  return (owner) =>
    resolver
      ? Boolean(gatewayOwner && hasGatewayContextOwner(owner, gatewayOwner))
      : getGatewayContextResolver(owner) === undefined;
}

export function captureRpcSourceScopeMatcher(scope: SessionRuntimeScope) {
  const matchesGateway = captureGatewayScopeMatcher(scope.resolveGatewayContext);
  return (ref: RpcSourceRef) =>
    ref.input.target?.storeScope === scope.storePath && matchesGateway(ref.input);
}
