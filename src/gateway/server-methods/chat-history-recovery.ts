import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveActiveEmbeddedRunOwnerForOperation } from "../../agents/embedded-agent-runner/runs.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { getRpcSourceForTarget } from "../../sessions/session-controller.rpc-sources.js";
import { findSessionControllerEntry } from "../../sessions/session-controller.state.js";
import { projectInFlightRunSnapshot } from "../chat-inflight-snapshot.js";
import { chatRunBelongsToSelectedAgent } from "../chat-run-owner.js";
import type { ChatRunState } from "../server-chat-state.js";
import { captureGatewayScopeMatcher, type SessionRuntimeScope } from "../session-runtime-scope.js";
import type { RespondFn } from "./types.js";

export function resolveEmbeddedAgentRunRecoverySnapshot(
  params: SessionRuntimeScope & {
    chatRunState: Pick<ChatRunState, "resolveBuffer" | "runs" | "registry">;
    requestedSessionKey: string;
    canonicalSessionKey: string;
    sessionId?: string;
    agentId?: string;
    defaultAgentId?: string;
  },
) {
  const target = captureSessionTarget({
    storeScope: params.storePath,
    sessionKey: params.canonicalSessionKey,
    aliases: [params.requestedSessionKey],
    incarnation: params.sessionId,
    agentId: params.agentId,
  });
  const controller = findSessionControllerEntry(params.canonicalSessionKey, target);
  const operation = controller?.active;
  if (
    !operation ||
    operation.result ||
    (params.sessionId !== undefined && operation.sessionId !== params.sessionId) ||
    !captureGatewayScopeMatcher(params.resolveGatewayContext)(operation)
  ) {
    return undefined;
  }
  const owner = resolveActiveEmbeddedRunOwnerForOperation(operation);
  if (!owner) {
    return undefined;
  }
  // Queued execution has its own runtime ID; history must retain the client
  // identity used by its live events and final reply.
  const registration = params.chatRunState.registry.peek(owner.runId);
  const source = registration && getRpcSourceForTarget(registration.clientRunId, target);
  const runId =
    registration &&
    source?.input.claim?.operation === operation &&
    (registration.sessionKey === params.requestedSessionKey ||
      registration.sessionKey === params.canonicalSessionKey) &&
    chatRunBelongsToSelectedAgent({
      agentId: registration.agentId,
      sessionKey: registration.sessionKey,
      selectedAgentId: params.agentId,
      defaultAgentId: params.defaultAgentId,
    })
      ? registration.clientRunId
      : owner.runId;
  return projectInFlightRunSnapshot({
    chatRunState: params.chatRunState,
    runId,
    startedAtMs: owner.startedAtMs,
    sessionAbortable: true,
  });
}

export type ChatHistoryMethod =
  | "chat.history"
  | "chat.startup"
  | "chat.message.get"
  | "chat.predict";

export function respondChatHistoryUnavailable(
  method: ChatHistoryMethod,
  respond: RespondFn,
  message: string,
): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, message, {
      details: { method },
      retryable: true,
      retryAfterMs: 250,
    }),
  );
}
