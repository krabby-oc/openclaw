import { beforeEach, expect, it, vi } from "vitest";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import type { SessionControllerMailboxClaim } from "../../sessions/session-controller.mailbox.js";
import type { FollowupRun } from "./queue.js";

const state = vi.hoisted(() => ({
  admit: vi.fn(),
  preflight: vi.fn(),
  resolveConfig: vi.fn(async (config: unknown) => config),
}));

vi.mock("../../sessions/session-controller.mailbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/session-controller.mailbox.js")>()),
  attachSessionControllerInputOperation: vi.fn(),
  bindSessionControllerInputOperation: vi.fn(),
  claimSessionControllerInput: vi.fn(),
  releaseSessionControllerClaim: vi.fn(),
}));
vi.mock("./agent-runner-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-utils.js")>()),
  resolveQueuedReplyExecutionConfig: (config: unknown) => state.resolveConfig(config),
  resolveQueuedReplyRuntimeConfig: (config: unknown) => config,
}));
vi.mock("./reply-turn-admission.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reply-turn-admission.js")>()),
  admitReplyTurn: (...args: unknown[]) => state.admit(...args),
}));
vi.mock("./reply-turn-preflight.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reply-turn-preflight.js")>()),
  prepareReplyTurnContext: (...args: unknown[]) => state.preflight(...args),
}));

const { prepareReplyAgentTurn } = await import("./reply-agent-turn-preparation.js");

function createRun(): FollowupRun {
  return {
    prompt: "hello",
    enqueuedAt: 1,
    run: {
      agentId: "agent",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      provider: "provider",
      model: "model",
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  };
}

function createOperation() {
  const operation = {
    sessionId: "session",
    abortSignal: new AbortController().signal,
    fail: vi.fn(),
    complete: vi.fn(),
    updateSessionId: vi.fn(),
  };
  return { operation: operation as unknown as ReplyOperation, spies: operation };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.admit.mockImplementation(async () => ({
    status: "owned",
    operation: createOperation().operation,
    sessionEntry: undefined,
  }));
  state.preflight.mockResolvedValue(undefined);
});

it("prepares immediate and queued turns through the same model and memory preflight", async () => {
  const signalRunStart = vi.fn(async () => {});
  const claimSource = async () =>
    ({ abortController: new AbortController() }) as SessionControllerMailboxClaim;
  for (const kind of ["visible", "queued_followup"] as const) {
    const result = await prepareReplyAgentTurn({
      queued: createRun(),
      defaults: {
        typing: {} as Parameters<typeof prepareReplyAgentTurn>[0]["defaults"]["typing"],
        typingMode: "never",
        defaultModel: "default-model",
      },
      kind,
      claimSource,
      signalRunStart,
    });
    expect(result.kind).toBe("admitted");
  }
  expect(state.resolveConfig).toHaveBeenCalledTimes(2);
  expect(state.preflight).toHaveBeenCalledTimes(2);
  expect(signalRunStart).toHaveBeenCalledTimes(2);
  expect(state.preflight.mock.calls.map(([params]) => params.defaultModel)).toEqual([
    "default-model",
    "default-model",
  ]);
});

it.each([null, "aborted_by_user", "aborted_for_restart"] as const)(
  "settles rejected admission once without replacing %s",
  async (code) => {
    const { operation, spies } = createOperation();
    Object.defineProperty(operation, "result", {
      value: code ? { kind: "aborted", code } : null,
    });
    state.admit.mockResolvedValue({ status: "owned", operation });
    const failure = new Error("source adoption failed");
    const settled = vi.fn(async () => {});

    await expect(
      prepareReplyAgentTurn({
        queued: createRun(),
        defaults: {
          typing: {} as Parameters<typeof prepareReplyAgentTurn>[0]["defaults"]["typing"],
          typingMode: "never",
          defaultModel: "default-model",
          opts: {
            onQueuedFollowupAdmitted: async () => {
              throw failure;
            },
            onQueuedFollowupSettled: settled,
          },
        },
        claimSource: async () =>
          ({ abortController: new AbortController() }) as SessionControllerMailboxClaim,
      }),
    ).rejects.toBe(failure);

    expect(settled).toHaveBeenCalledOnce();
    expect(spies.complete).toHaveBeenCalledOnce();
    if (code) {
      expect(spies.fail).not.toHaveBeenCalled();
      expect(operation.result).toEqual({ kind: "aborted", code });
    } else {
      expect(spies.fail).toHaveBeenCalledExactlyOnceWith("run_failed", failure);
    }
    expect(state.preflight).not.toHaveBeenCalled();
  },
);
