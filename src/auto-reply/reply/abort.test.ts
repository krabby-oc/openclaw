// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "../../gateway/server-methods/chat.abort-registry.test-support.js";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { isSubagentRegistryWriteCommand } from "../../agents/subagent-test-fixtures.test-helpers.js";
import { rowToSubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.store.codec.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadSessionEntry,
  markSessionAbortTarget,
  replaceSessionEntry,
  resolveSessionAbortTarget,
  type SessionAbortTargetResult,
} from "../../config/sessions/session-accessor.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { shouldSkipMessageByAbortCutoff } from "./abort-cutoff.js";
import { stopSubagentsForRequester } from "./abort-operation.js";
import { getAbortMemory, isAbortRequestText, setAbortMemory } from "./abort-primitives.js";
import { enqueueAbortFollowupRun } from "./abort-queue.test-support.js";
import { addSubagentFixture } from "./abort-subagent-registry.test-support.js";
import { formatAbortReplyText, tryFastAbortFromMessage } from "./abort.js";
import { getFollowupQueueDepth } from "./queue.js";
import { clearFollowupQueue } from "./queue/state.js";
import { createReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import { testing as replyRunRegistryTesting } from "./reply-run-registry.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

type AbortEmbeddedAgentRunOptions = Parameters<
  typeof import("../../agents/embedded-agent-runner/runs.js").abortEmbeddedAgentRun
>[1];

vi.mock("../../agents/embedded-agent.js", () => ({
  abortEmbeddedAgentRun: vi.fn().mockReturnValue(true),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));

const commandQueueMocks = vi.hoisted(() => ({
  clearCommandLane: vi.fn<typeof import("../../process/command-queue.js").clearCommandLane>(
    () => 1,
  ),
}));

vi.mock(import("../../process/command-queue.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  ...commandQueueMocks,
}));

const acpManagerMocks = vi.hoisted(() => ({
  resolveSession: vi.fn<
    () =>
      | { kind: "none" }
      | {
          kind: "ready";
          sessionKey: string;
          meta: unknown;
        }
  >(() => ({ kind: "none" })),
  cancelSession: vi.fn(async () => {}),
}));

const runtimeAbortMocks = vi.hoisted(() => ({
  abortEmbeddedAgentRun: vi.fn<
    (sessionId: string | undefined, opts?: AbortEmbeddedAgentRunOptions) => boolean
  >(() => true),
  resolveActiveEmbeddedRunSessionId: vi.fn(() => undefined as string | undefined),
  isEmbeddedAgentRunActive: vi.fn(() => false),
}));

vi.mock("../../agents/embedded-agent-runner/runs.js", () => ({
  abortEmbeddedAgentRun: runtimeAbortMocks.abortEmbeddedAgentRun,
  isEmbeddedAgentRunActive: runtimeAbortMocks.isEmbeddedAgentRunActive,
}));
vi.mock(
  import("../../agents/embedded-agent-runner/runs.abort-target.js"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    prepareEmbeddedAgentRunAbort: (sessionId: string) => () => ({
      active:
        runtimeAbortMocks.isEmbeddedAgentRunActive() ||
        runtimeAbortMocks.resolveActiveEmbeddedRunSessionId() === sessionId,
      aborted: runtimeAbortMocks.abortEmbeddedAgentRun(sessionId),
      sessionId,
    }),
  }),
);
vi.mock("../../agents/embedded-agent-runner/active-run-projections.js", () => ({
  resolveActiveEmbeddedRunSessionId: runtimeAbortMocks.resolveActiveEmbeddedRunSessionId,
}));
vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    markSessionAbortTarget: vi.fn(actual.markSessionAbortTarget),
    resolveSessionAbortTarget: vi.fn(actual.resolveSessionAbortTarget),
  };
});

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: acpManagerMocks.resolveSession,
    cancelSession: acpManagerMocks.cancelSession,
  }),
}));

describe("abort detection", () => {
  it("isAbortRequestText aligns abort command semantics", () => {
    for (const text of [
      "/stop",
      "/STOP",
      "/stop!!!",
      "/Stop!!!",
      "stop",
      "Stop",
      "STOP",
      "stop action",
      "stop openclaw!!!",
      "停下来",
      "暂停",
      "やめて",
      "остановись",
      "halt",
      "stopp",
      "pare",
      " توقف ",
      "do not do that",
    ]) {
      expect(isAbortRequestText(text), text).toBe(true);
    }
    for (const text of ["/stop@openclaw_bot", "/Stop@openclaw_bot"]) {
      expect(isAbortRequestText(text, { botUsername: "openclaw_bot" }), text).toBe(true);
    }
    for (const text of ["/stop@unresolved_bot", "/stop@unresolved_bot!"]) {
      expect(isAbortRequestText(text, { targetedCommandMode: "pre-identity" }), text).toBe(true);
    }
    expect(
      isAbortRequestText("/queue@unresolved_bot", { targetedCommandMode: "pre-identity" }),
    ).toBe(false);
    expect(
      isAbortRequestText("/stop@some_other_bot", {
        botUsername: "openclaw_bot",
        targetedCommandMode: "pre-identity",
      }),
    ).toBe(false);

    for (const text of ["/status", "wait", "please wait", "please do not do that", "/abort"]) {
      expect(isAbortRequestText(text), text).toBe(false);
    }
  });

  it("treats numeric message IDs at or before cutoff as stale", () => {
    for (const [messageSid, stale] of [
      ["199", true],
      ["200", true],
      ["201", false],
    ] as const) {
      expect(shouldSkipMessageByAbortCutoff({ cutoffMessageSid: "200", messageSid })).toBe(stale);
    }
  });

  it("falls back to timestamp cutoff when message IDs are unavailable", () => {
    for (const [timestamp, stale] of [
      [1999, true],
      [2000, true],
      [2001, false],
    ] as const) {
      expect(shouldSkipMessageByAbortCutoff({ cutoffTimestamp: 2000, timestamp })).toBe(stale);
    }
  });
});

describe("abort handling", () => {
  const abortFixture = useChatAbortRegistryFixture();
  const trackedAbortMemoryKeys = new Set<string>();

  async function createAbortConfig(sessionIdsByKey: Record<string, string> = {}) {
    const root = abortFixture.stateDir;
    const storePath = path.join(root, "sessions.json");
    const cfg: OpenClawConfig = { session: { store: storePath } };
    for (const [sessionKey, sessionId] of Object.entries(sessionIdsByKey)) {
      trackedAbortMemoryKeys.add(sessionKey);
      await replaceSessionEntry({ storePath, sessionKey }, { sessionId, updatedAt: Date.now() });
    }
    return { root, storePath, cfg };
  }

  async function runStopCommand(
    cfg: OpenClawConfig,
    overrides: Parameters<typeof buildTestCtx>[0],
  ) {
    const ctx = buildTestCtx({
      CommandBody: "/stop",
      RawBody: "/stop",
      CommandAuthorized: true,
      Provider: "telegram",
      Surface: "telegram",
      From: "telegram:123",
      To: "telegram:123",
      ...overrides,
    });
    for (const key of [
      ctx.SessionKey,
      ctx.ParentSessionKey,
      ctx.CommandTargetSessionKey,
      ctx.From,
      ctx.To,
    ]) {
      if (key) {
        trackedAbortMemoryKeys.add(key);
      }
    }
    return tryFastAbortFromMessage({ ctx, cfg });
  }

  function enqueueQueuedFollowupRun(params: Parameters<typeof enqueueAbortFollowupRun>[0]) {
    trackedAbortMemoryKeys.add(params.sessionKey);
    enqueueAbortFollowupRun(params);
  }

  function expectSessionLaneCleared(sessionKey: string) {
    expect(commandQueueMocks.clearCommandLane.mock.calls.map(([lane]) => lane)).toContain(
      `session:${sessionKey}`,
    );
  }

  function createOperation(sessionKey: string, sessionId: string, agentId?: string) {
    return createReplyOperation({ sessionKey, sessionId, agentId, resetTriggered: false });
  }

  function attachStreamingBackend(operation: ReturnType<typeof createReplyOperation>) {
    operation.attachBackend({ kind: "embedded", cancel: () => {}, isStreaming: () => true });
  }

  function resolvedTarget(sessionKey: string, sessionId: string) {
    return { entry: { sessionId, updatedAt: 10 }, sessionId, sessionKey };
  }

  async function addChild(
    storePath: string,
    childSessionKey: string,
    runId: string,
    requesterSessionKey: string,
  ) {
    const scope = { storePath, agentId: "main", sessionKey: childSessionKey };
    const entry = loadSessionEntry(scope)!;
    await replaceSessionEntry(scope, {
      ...entry,
      lifecycleRevision: `${entry.sessionId}-revision`,
    });
    await addSubagentFixture({
      runId,
      childSessionKey,
      childAgentId: "main",
      sessionEntry: loadSessionEntry(scope),
      requesterSessionKey,
      requesterDisplayKey: requesterSessionKey,
      task: runId,
      cleanup: "keep",
      createdAt: Date.now(),
    });
  }

  function expectStopped(
    operation: ReturnType<typeof createReplyOperation>,
    sessionKey: string,
    sessionId: string,
  ) {
    expect(operation.abortSignal.aborted).toBe(true);
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(sessionId);
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expectSessionLaneCleared(sessionKey);
    expect(getAbortMemory(sessionKey)).toBeUndefined();
  }

  function bindAcpSessionForTest(targetSessionKey: string) {
    vi.spyOn(getSessionBindingService(), "resolveByConversationAsync").mockImplementation(
      async (conversation) => ({
        bindingId: "test-acp-binding",
        targetKind: "session",
        targetSessionKey,
        conversation,
        status: "active",
        boundAt: 0,
      }),
    );
  }

  beforeEach(() => {
    commandQueueMocks.clearCommandLane.mockClear().mockReturnValue(1);
  });

  afterEach(() => {
    for (const key of trackedAbortMemoryKeys) {
      setAbortMemory(key, false);
      clearFollowupQueue(key);
    }
    trackedAbortMemoryKeys.clear();
    vi.restoreAllMocks();
    vi.mocked(markSessionAbortTarget).mockReset();
    vi.mocked(resolveSessionAbortTarget).mockReset();
    replyRunRegistryTesting.resetReplyRunRegistry();
    commandQueueMocks.clearCommandLane.mockClear().mockReturnValue(1);
    acpManagerMocks.resolveSession.mockReset().mockReturnValue({ kind: "none" });
    acpManagerMocks.cancelSession.mockReset().mockResolvedValue(undefined);
    runtimeAbortMocks.abortEmbeddedAgentRun.mockReset().mockReturnValue(true);
    runtimeAbortMocks.resolveActiveEmbeddedRunSessionId.mockReset().mockReturnValue(undefined);
  });

  it("resolves owner authorization after loading cancellation runtime", async () => {
    const sessionKey = "telegram:123";
    const sessionId = "session-123";
    const { root, cfg } = await createAbortConfig({ [sessionKey]: sessionId });
    cfg.commands = { ownerAllowFrom: ["telegram:123"] };
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
    const pending = runStopCommand(cfg, { SessionKey: sessionKey, SenderId: "123" });
    cfg.commands.ownerAllowFrom = ["telegram:other-owner"];

    await expect(pending).resolves.toEqual({ handled: false, aborted: false });
    expect(getFollowupQueueDepth(sessionKey)).toBe(1);
  });

  it("fast-abort still stops active runs when abort metadata persistence fails", async () => {
    const sessionKey = "telegram:persistence-failure";
    const sessionId = "session-persistence-failure";
    const activeSessionId = "active-persistence-failure";
    const { root, cfg } = await createAbortConfig({ [sessionKey]: sessionId });
    const operation = createOperation(sessionKey, activeSessionId, "main");
    attachStreamingBackend(operation);
    vi.mocked(markSessionAbortTarget).mockRejectedValueOnce(
      new Error("simulated persistence failure"),
    );
    enqueueQueuedFollowupRun({ root, cfg, sessionId: activeSessionId, sessionKey });

    const result = await runStopCommand(cfg, { SessionKey: sessionKey });

    expect(result.handled).toBe(true);
    expectStopped(operation, sessionKey, activeSessionId);
  });

  it("fast-abort uses resolved target identity when abort metadata save fails", async () => {
    const requestedKey = "Agent:Main:Telegram:Group:-1001234567890:Topic:99";
    const canonicalKey = "agent:main:telegram:group:-1001234567890:topic:99";
    const sessionId = "resolved-persistence-failure";
    const { root, cfg } = await createAbortConfig();
    const operation = createOperation(canonicalKey, sessionId, "main");
    attachStreamingBackend(operation);
    vi.mocked(markSessionAbortTarget).mockResolvedValueOnce({
      ...resolvedTarget(canonicalKey, sessionId),
      persisted: false,
      persistenceError: "simulated persistence failure",
    });
    vi.mocked(resolveSessionAbortTarget).mockResolvedValueOnce(
      resolvedTarget(canonicalKey, sessionId),
    );
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey: canonicalKey });

    const result = await runStopCommand(cfg, { SessionKey: requestedKey });

    expect(result.handled).toBe(true);
    expectStopped(operation, canonicalKey, sessionId);
  });

  it("fast-abort leaves future prompts untouched when no persisted target entry exists", async () => {
    const sessionKey = "telegram:missing-persistence-target";
    const { cfg } = await createAbortConfig();
    vi.mocked(markSessionAbortTarget).mockResolvedValueOnce(null);
    vi.mocked(resolveSessionAbortTarget).mockResolvedValueOnce(null);

    const result = await runStopCommand(cfg, { SessionKey: sessionKey });

    expect(result.handled).toBe(true);
    expect(getAbortMemory(sessionKey)).toBeUndefined();
  });

  it("fast-abort does not wait for abort metadata persistence before stopping runs", async () => {
    const sessionKey = "telegram:slow-persistence";
    const childKey = "agent:main:subagent:slow-persistence-child";
    const sessionId = "session-slow-persistence";
    const childSessionId = "session-slow-persistence-child";
    const { root, storePath, cfg } = await createAbortConfig({
      [childKey]: childSessionId,
      [sessionKey]: sessionId,
    });
    const operation = createOperation(sessionKey, sessionId, "main");
    attachStreamingBackend(operation);
    const persistenceStarted = createDeferred();
    const persistence = createDeferred<SessionAbortTargetResult | null>();
    vi.mocked(markSessionAbortTarget).mockImplementationOnce(() => {
      persistenceStarted.resolve();
      return persistence.promise;
    });
    vi.mocked(resolveSessionAbortTarget).mockResolvedValueOnce(
      resolvedTarget(sessionKey, sessionId),
    );
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
    await addChild(storePath, childKey, "slow-child-run", sessionKey);

    const resultPromise = runStopCommand(cfg, { SessionKey: sessionKey });
    await persistenceStarted.promise;

    expect(operation.abortSignal.aborted).toBe(true);
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(sessionId);
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(childSessionId);
    expect(await getSubagentRunByChildSessionKey(childKey)).toMatchObject({
      endedReason: "subagent-killed",
      killReconciliation: { suppressTaskDelivery: true },
    });
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expectSessionLaneCleared(sessionKey);

    persistence.resolve({ ...resolvedTarget(sessionKey, sessionId), persisted: true });
    await expect(resultPromise).resolves.toMatchObject({
      aborted: true,
      handled: true,
    });
  });

  it("ACP cancel failures do not skip queue and lane cleanup", async () => {
    const sessionKey = "agent:codex:acp:test-2";
    const sessionId = "session-456";
    const { root, cfg } = await createAbortConfig({ [sessionKey]: sessionId });
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
    acpManagerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey,
      meta: {} as never,
    });
    acpManagerMocks.cancelSession.mockRejectedValueOnce(new Error("cancel failed"));

    const result = await runStopCommand(cfg, {
      SessionKey: sessionKey,
      CommandTargetSessionKey: sessionKey,
    });

    expect(result.handled).toBe(true);
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expectSessionLaneCleared(sessionKey);
  });

  it("signals the native parent before deferred ACP cancellation and never retargets its replacement", async () => {
    const sessionKey = "agent:main:discord:channel:deferred-acp";
    const acpKey = "agent:main:acp:deferred-acp";
    const { root, cfg } = await createAbortConfig({
      [sessionKey]: "native-session",
      [acpKey]: "acp-session",
    });
    const native = createOperation(sessionKey, "native-session");
    attachStreamingBackend(native);
    enqueueQueuedFollowupRun({ root, cfg, sessionId: "native-session", sessionKey });
    bindAcpSessionForTest(acpKey);
    acpManagerMocks.resolveSession.mockReturnValue({ kind: "ready", sessionKey: acpKey, meta: {} });
    const entered = createDeferred();
    const proceed = createDeferred();
    acpManagerMocks.cancelSession.mockImplementationOnce(async () => {
      entered.resolve();
      await proceed.promise;
    });
    const pending = runStopCommand(cfg, {
      SessionKey: sessionKey,
      From: "discord:deferred-acp",
      To: "discord:deferred-acp",
    });
    let replacement: ReturnType<typeof createReplyOperation> | undefined;
    try {
      await entered.promise;
      expect(native.abortSignal.aborted).toBe(true);
      expect(getFollowupQueueDepth(sessionKey)).toBe(0);
      native.complete();
      replacement = createOperation(sessionKey, "replacement-session");
      attachStreamingBackend(replacement);
      proceed.resolve();
      await pending;
      expect(replacement.abortSignal.aborted).toBe(false);
    } finally {
      proceed.resolve();
      await pending;
      native.complete();
      replacement?.complete();
    }
  });

  it("propagates a callback failure without a requester", async () => {
    const beforeKill = vi.fn(() => {
      throw new Error("parent cancellation failed");
    });
    await expect(
      stopSubagentsForRequester({ cfg: {}, requesterSessionKey: undefined, beforeKill }),
    ).rejects.toThrow("parent cancellation failed");
    expect(beforeKill).toHaveBeenCalledOnce();
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
  });

  it("does not report /stop success after the active backend freezes its outcome", async () => {
    const sessionKey = "agent:main:telegram:direct:finalizing";
    const sessionId = "session-finalizing";
    const { cfg } = await createAbortConfig({ [sessionKey]: sessionId });
    const cancel = vi.fn();
    const operation = createOperation(sessionKey, sessionId);
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
      isAbortable: () => false,
    });
    operation.setPhase("running");
    runtimeAbortMocks.abortEmbeddedAgentRun.mockReturnValue(false);
    runtimeAbortMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(sessionId);
    vi.mocked(markSessionAbortTarget).mockClear();

    const result = await runStopCommand(cfg, {
      SessionKey: sessionKey,
      From: "telegram:finalizing",
      To: "telegram:finalizing",
    });

    expect(result).toMatchObject({
      handled: true,
      aborted: false,
      rejectionReason: "finalizing",
    });
    expect(operation.result).toBeNull();
    expect(replyRunRegistry.isActive(sessionKey)).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    expect(markSessionAbortTarget).not.toHaveBeenCalled();
    expect(getAbortMemory(sessionKey)).toBeUndefined();
    expect(formatAbortReplyText(undefined, result.rejectionReason)).toBe(
      "Agent reply is already finalizing and can no longer be aborted.",
    );
    expect(formatAbortReplyText(0, undefined, 1)).toBe(
      "⚙️ Agent was aborted. Cancellation was incomplete for 1 sub-agent. Retry /stop.",
    );
    operation.complete();
  });

  it.each([false, true])(
    "aborts an explicit ACP source only when bound (bound=%s)",
    async (bound) => {
      const sourceSessionKey = "agent:main:discord:channel:C3";
      const acpSessionKey = "agent:codex:acp:unbound-explicit-target";
      const { cfg } = await createAbortConfig({
        [sourceSessionKey]: "source-store-session",
        [acpSessionKey]: "acp-store-session",
      });
      const sourceOperation = createOperation(sourceSessionKey, "source-active-session");
      if (bound) {
        bindAcpSessionForTest(acpSessionKey);
      }
      acpManagerMocks.resolveSession.mockReturnValue({
        kind: "ready",
        sessionKey: acpSessionKey,
        meta: {} as never,
      });

      const result = await runStopCommand(cfg, {
        ...(bound ? { ParentSessionKey: sourceSessionKey } : { SessionKey: sourceSessionKey }),
        From: "discord:C3",
        To: "discord:C3",
        CommandTargetSessionKey: acpSessionKey,
        CommandSource: "native",
      });

      expect(result.handled).toBe(true);
      expect(sourceOperation.result).toEqual(
        bound ? { kind: "aborted", code: "aborted_by_user" } : null,
      );
      expect(replyRunRegistry.isActive(sourceSessionKey)).toBe(!bound);
      if (!bound) {
        expect(acpManagerMocks.cancelSession).toHaveBeenCalledWith({
          cfg,
          sessionKey: acpSessionKey,
          reason: "fast-abort",
        });
        sourceOperation.complete();
      }
    },
  );

  it("continues stopping siblings when one termination persistence write fails", async () => {
    const sessionKey = "telegram:persistence-failure-parent";
    const firstChildKey = "agent:main:subagent:persistence-failure-first";
    const secondChildKey = "agent:main:subagent:persistence-failure-second";
    const { storePath, cfg } = await createAbortConfig({
      [sessionKey]: "persistence-failure-parent",
      [firstChildKey]: "run-persistence-failure-first",
      [secondChildKey]: "run-persistence-failure-second",
    });
    for (const [runId, childKey] of [
      ["run-persistence-failure-first", firstChildKey],
      ["run-persistence-failure-second", secondChildKey],
    ] as const) {
      await addChild(storePath, childKey, runId, sessionKey);
    }
    let failedTombstone = false;
    probe.command(stateWorker, async (command, executeOptions, scope) => {
      if (isSubagentRegistryWriteCommand(command) && !failedTombstone) {
        const firstRow = command.input.values.find(
          (row) => row.run_id === "run-persistence-failure-first",
        );
        const first = firstRow && rowToSubagentRunRecord(firstRow);
        if (first?.execution.status === "terminal" && first.endedReason === "subagent-killed") {
          failedTombstone = true;
          throw new Error("sqlite busy");
        }
      }
      return scope.execute(command, executeOptions);
    });

    await expect(
      stopSubagentsForRequester({
        cfg,
        requesterSessionKey: sessionKey,
      }),
    ).resolves.toEqual({ stopped: 1, failed: 1 });
    expect(failedTombstone).toBe(true);
    expect((await getSubagentRunByChildSessionKey(firstChildKey))?.killIntent).toBeDefined();
    expect((await getSubagentRunByChildSessionKey(secondChildKey))?.endedReason).toBe(
      "subagent-killed",
    );
    expectSessionLaneCleared(firstChildKey);
    expectSessionLaneCleared(secondChildKey);
  });
});
