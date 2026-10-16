/**
 * Tests agent harness runtime helpers and task dispatch behavior.
 */
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, assert, describe, expect, expectTypeOf, it, vi } from "vitest";
import { isEmbeddedAgentRunHandleActive } from "../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  registerTestEmbeddedRun,
  testing as embeddedRunsTesting,
} from "../agents/embedded-agent-runner/runs.test-support.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../sessions/session-controller.mailbox.js";
import {
  abortAgentHarnessRun,
  AgentHarnessPreflightError,
  agentHarnessStructuredInput,
  attachModelProviderRequestTransport,
  buildAgentHarnessUserInputAnswers,
  classifyAgentHarnessTerminalOutcome,
  clearActiveEmbeddedRun,
  deliverAgentHarnessUserInputPrompt,
  formatAgentHarnessUserInputPrompt,
  getModelProviderRequestTransport,
  queueAgentHarnessMessage,
  setActiveEmbeddedRun,
  type AgentHarness,
  type AgentHarnessQuestionGatewayCall,
  type AgentHarnessAttemptParams,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessSideQuestionParams,
  type AgentHarnessSideQuestionParamsV2,
  type AgentHarnessSessionForkParams,
  type AgentHarnessV2,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptParamsV2,
  type HarnessContextEngine,
} from "./agent-harness-runtime.js";

describe("classifyAgentHarnessTerminalOutcome", () => {
  function classify(overrides: Partial<Parameters<typeof classifyAgentHarnessTerminalOutcome>[0]>) {
    return classifyAgentHarnessTerminalOutcome({
      assistantTexts: [],
      reasoningText: "",
      planText: "",
      promptError: null,
      turnCompleted: true,
      ...overrides,
    });
  }

  it("accepts prepared literal NO_REPLY text as visible output", () => {
    expect(classify({ assistantTexts: ["NO_REPLY"] })).toBeUndefined();
  });

  it("treats whitespace-only assistant text as not visible", () => {
    expect(classify({ assistantTexts: ["  ", "\n\t"] })).toBe("empty");
  });

  it("prefers planning-only when both plan and reasoning text are present", () => {
    expect(
      classify({
        reasoningText: "I need to inspect the files.",
        planText: "I will inspect, patch, and test.",
      }),
    ).toBe("planning-only");
  });

  it("classifies a completed turn with reasoning text only as reasoning-only", () => {
    expect(classify({ reasoningText: "The answer depends on the current repository state." })).toBe(
      "reasoning-only",
    );
  });
});

describe("agent harness runtime SDK facade", () => {
  it("preserves the published failure-retention opt-in on attempt operations", () => {
    expectTypeOf<
      NonNullable<AgentHarnessAttemptParams["replyOperation"]>["retainFailureUntilComplete"]
    >().toEqualTypeOf<() => void>();
    expectTypeOf<
      NonNullable<EmbeddedRunAttemptParamsV2["replyOperation"]>["retainFailureUntilComplete"]
    >().toEqualTypeOf<() => void>();
  });

  it("exposes optional compaction progress without requiring it from legacy engines", () => {
    type CompactParams = Parameters<HarnessContextEngine["compact"]>[0];
    expectTypeOf<CompactParams["onProgress"]>().toEqualTypeOf<(() => void) | undefined>();
    expectTypeOf<Omit<CompactParams, "onProgress">>().toMatchTypeOf<CompactParams>();
  });

  it("exposes structured input through one frozen named runtime surface", () => {
    expect(Object.isFrozen(agentHarnessStructuredInput)).toBe(true);
    expect(Object.keys(agentHarnessStructuredInput).toSorted()).toEqual([
      "compileForm",
      "compileQuestions",
      "compileUrl",
      "isRecord",
      "run",
      "snapshot",
    ]);
  });

  it("keeps legacy harness implementations source-compatible while requiring capabilities in V2", () => {
    type SessionForkParamsV2 = Parameters<NonNullable<AgentHarnessV2["sessionForkV2"]>["fork"]>[0];
    const legacyHarness = {
      id: "legacy-test",
      label: "Legacy test harness",
      supports: () => ({ supported: true as const, priority: 1 }),
      runAttempt: async (_params: AgentHarnessAttemptParams) => {
        throw new Error("type-only legacy harness");
      },
      runSideQuestion: async (_params: AgentHarnessSideQuestionParams) => ({ text: "legacy" }),
    } satisfies AgentHarness;

    expectTypeOf(legacyHarness).toMatchTypeOf<AgentHarness>();
    expectTypeOf<AgentHarnessV2>().toMatchTypeOf<AgentHarness>();
    expectTypeOf<
      Omit<AgentHarnessSideQuestionParams, "hostCapabilities">
    >().toMatchTypeOf<AgentHarnessSideQuestionParams>();
    expectTypeOf<
      Omit<AgentHarnessAttemptParams, "hostCapabilities">
    >().toMatchTypeOf<AgentHarnessAttemptParams>();
    expectTypeOf<
      Omit<EmbeddedRunAttemptParams, "hostCapabilities">
    >().toMatchTypeOf<EmbeddedRunAttemptParams>();
    expectTypeOf<AgentHarnessAttemptParams["replyOperation"]>().toEqualTypeOf<
      EmbeddedRunAttemptParams["replyOperation"]
    >();
    expectTypeOf<
      Omit<AgentHarnessAttemptParamsV2, "hostCapabilities"> extends AgentHarnessAttemptParamsV2
        ? true
        : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      Omit<EmbeddedRunAttemptParamsV2, "hostCapabilities"> extends EmbeddedRunAttemptParamsV2
        ? true
        : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      Omit<
        AgentHarnessSideQuestionParamsV2,
        "hostCapabilities"
      > extends AgentHarnessSideQuestionParamsV2
        ? true
        : false
    >().toEqualTypeOf<false>();

    expectTypeOf<
      Omit<SessionForkParamsV2, "assertCurrent">
    >().toEqualTypeOf<AgentHarnessSessionForkParams>();
    expectTypeOf<
      Omit<SessionForkParamsV2, "assertCurrent"> extends SessionForkParamsV2 ? true : false
    >().toEqualTypeOf<false>();

    // V1 injection remains supported inside a host-admitted harness attempt.
    type QueueOptions = Parameters<typeof queueAgentHarnessMessage>[2];
    const legacyInjection = {
      isAvailable: () => true,
      queueMessage: async (_text: string, _options?: QueueOptions) => {},
    };
    const legacyHandle = {
      queueMessage: legacyInjection.queueMessage,
      messageInjection: legacyInjection,
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
    } satisfies Parameters<typeof setActiveEmbeddedRun>[1];
    expectTypeOf(legacyHandle).toMatchTypeOf<Parameters<typeof setActiveEmbeddedRun>[1]>();
    expectTypeOf<
      Extract<keyof Parameters<typeof setActiveEmbeddedRun>[1], symbol>
    >().toEqualTypeOf<never>();
    expectTypeOf<Parameters<typeof setActiveEmbeddedRun>["length"]>().toEqualTypeOf<
      2 | 3 | 4 | 5
    >();
    expectTypeOf<ReturnType<typeof setActiveEmbeddedRun>>().toEqualTypeOf<
      ((reason?: string) => void) | undefined
    >();
    expectTypeOf(queueAgentHarnessMessage).returns.toEqualTypeOf<boolean>();
    type GuardedInjection = NonNullable<
      Parameters<typeof setActiveEmbeddedRun>[1]["messageInjectionV2"]
    >;
    expectTypeOf<Parameters<GuardedInjection["queueMessage"]>[2]>().toEqualTypeOf<() => void>();
    expectTypeOf<Parameters<GuardedInjection["queueMessage"]>[3]>().toEqualTypeOf<
      "run" | "source-bound"
    >();
    expectTypeOf<Parameters<GuardedInjection["queueMessage"]>["length"]>().toEqualTypeOf<4>();
  });

  it("keeps legacy question callbacks and requires explicit guarded dispatch authority", () => {
    type Legacy = (
      method: string,
      opts: { timeoutMs?: number },
      params?: unknown,
      extra?: { signal?: AbortSignal },
    ) => Promise<unknown>;
    expectTypeOf<AgentHarnessQuestionGatewayCall>().toEqualTypeOf<Legacy>();
    type Override = Parameters<typeof agentHarnessStructuredInput.run>[0]["gatewayCall"];
    expectTypeOf<Legacy>().toMatchTypeOf<Override>();
    expectTypeOf<undefined>().toMatchTypeOf<Override>();
    type Dispatcher = Exclude<Override, Legacy | undefined>;
    type Request = Parameters<Dispatcher["call"]>[0];
    type Protected = Extract<Request["authority"], { kind: "source-bound" }>;
    expectTypeOf<Dispatcher["version"]>().toEqualTypeOf<2>();
    expectTypeOf<Protected["assertCurrent"]>().toEqualTypeOf<() => void>();
    expectTypeOf<Omit<Protected, "assertCurrent">>().not.toMatchTypeOf<Protected>();
  });

  it("exposes attached model request transport metadata helpers", () => {
    const model = attachModelProviderRequestTransport(
      { id: "gpt-test", provider: "custom-openai" },
      { auth: { mode: "header", headerName: "x-api-key", value: "secret" } },
    );

    expect(getModelProviderRequestTransport(model)).toEqual({
      auth: { mode: "header", headerName: "x-api-key", value: "secret" },
    });
  });
});

describe("agent harness active-run SDK controls", () => {
  afterEach(() => embeddedRunsTesting.resetActiveEmbeddedRuns());

  it("rejects a session-keyed registration without host admission", () => {
    const handle = createEmbeddedRunHandle();
    let failure: unknown;
    try {
      setActiveEmbeddedRun("unadmitted", handle, "agent:main:unadmitted");
    } catch (error) {
      failure = error;
    }
    assert.instanceOf(failure, AgentHarnessPreflightError);
    expect(failure.code).toBe("SESSION_CONTROLLER_ADMISSION_REQUIRED");
    expect(failure.scope).toBeUndefined();
    expect(failure.message).toContain("runAttempt");
    expect(failure.userMessage).toBe(failure.message);
  });

  it("steers and interrupts the admitted turn while keeping waiting input", async () => {
    const queueMessage = vi.fn(async () => {});
    const operation = registerTestEmbeddedRun(
      "sdk-turn",
      createEmbeddedRunHandle({ queueMessage }),
      "agent:main:sdk-turn",
    );
    expect(queueAgentHarnessMessage("sdk-turn", "steer")).toBe(true);
    await vi.waitFor(() => expect(queueMessage).toHaveBeenCalledOnce());
    const waiting = reserveSessionControllerSource("agent:main:sdk-turn", {
      policy: { mode: "followup" },
    });
    try {
      expect(abortAgentHarnessRun("sdk-turn")).toBe(true);
      expect(operation.result).toMatchObject({ kind: "aborted", code: "aborted_by_user" });
      expect(waiting.retirementRequested).toBeUndefined();
    } finally {
      retireSessionControllerInput(waiting);
    }
  });

  it("keeps sessionless native work detached from session steering", () => {
    const queueMessage = vi.fn(async () => {});
    const abort = vi.fn();
    setActiveEmbeddedRun("sdk-detached", createEmbeddedRunHandle({ queueMessage, abort }));
    expect(queueAgentHarnessMessage("sdk-detached", "steer")).toBe(false);
    expect(abortAgentHarnessRun("sdk-detached")).toBe(true);
    expect(queueMessage).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledOnce();
  });

  it("keeps retained cleanup bound to its exact registration", () => {
    const handle = createEmbeddedRunHandle();
    const priorCleanup = setActiveEmbeddedRun("sdk-cleanup", handle);
    const currentCleanup = expectDefined(
      setActiveEmbeddedRun("sdk-cleanup", handle),
      "current registration cleanup",
    );
    assert.isFunction(priorCleanup);
    assert.isFunction(currentCleanup);
    clearActiveEmbeddedRun(
      "sdk-cleanup",
      handle,
      undefined,
      undefined,
      "old_cleanup",
      priorCleanup,
    );
    expect(isEmbeddedAgentRunHandleActive("sdk-cleanup")).toBe(true);
    currentCleanup("current_cleanup");
    expect(isEmbeddedAgentRunHandleActive("sdk-cleanup")).toBe(false);
  });
});

describe("agent harness user input helpers", () => {
  it("formats prompts and delivers through blocking replies first", async () => {
    const onBlockReply = vi.fn();

    await deliverAgentHarnessUserInputPrompt(
      { onBlockReply },
      [
        {
          id: "mode",
          header: "Mode",
          question: "Pick a mode",
          isOther: true,
          options: [{ label: "Deep", description: "Use more context" }],
        },
      ],
      { intro: "Runtime needs input:" },
    );

    expect(onBlockReply).toHaveBeenCalledWith({
      text: [
        "Runtime needs input:",
        "",
        "Mode",
        "Pick a mode",
        "1. Deep - Use more context",
        "Other: reply with your own answer.",
      ].join("\n"),
    });
  });

  it("keeps a comma-containing option label as one multi-select answer", () => {
    expect(
      buildAgentHarnessUserInputAnswers(
        [
          {
            id: "region",
            header: "Region",
            question: "Which region should deploy?",
            multiSelect: true,
            isOther: true,
            options: [{ label: "Frankfurt, Germany" }, { label: "Dublin, Ireland" }],
          },
        ],
        "Frankfurt, Germany",
      ),
    ).toEqual({ answers: { region: { answers: ["Frankfurt, Germany"] } } });
  });

  it("supports runtime-specific text formatting", () => {
    expect(
      formatAgentHarnessUserInputPrompt(
        [
          {
            id: "answer",
            header: "Header",
            question: "a < b",
          },
        ],
        { formatText: (text) => text.replaceAll("<", "&lt;") },
      ),
    ).toContain("a &lt; b");
  });

  it("preserves blank fallback lines so skipped answers stay aligned", () => {
    expect(
      buildAgentHarnessUserInputAnswers(
        [
          { id: "q1", header: "Q1", question: "First?" },
          { id: "q2", header: "Q2", question: "Second?" },
          { id: "q3", header: "Q3", question: "Third?" },
        ],
        "\nyes\nno",
      ),
    ).toEqual({
      answers: {
        q1: { answers: [] },
        q2: { answers: ["yes"] },
        q3: { answers: ["no"] },
      },
    });
  });
});
