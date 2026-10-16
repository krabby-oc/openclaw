// Verifies OpenAI Responses replay preserves reasoning and response item ids.
import "../test-utils/prepare-compiled-subprocesses.js";
import type { AssistantMessage, Context, Model, ToolResultMessage } from "openclaw/plugin-sdk/llm";
import { stream } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";

function buildModel(): Model<"openai-responses"> {
  return {
    id: "gpt-5.4",
    name: "gpt-5.4",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

function buildStorelessCustomModel(): Model<"openai-responses"> {
  return {
    ...buildModel(),
    provider: "custom-openai-responses",
    baseUrl: "https://custom.example.invalid/v1",
    compat: {
      supportsStore: false,
    } as never,
  };
}

function isInputRecord(item: unknown): item is Record<string, unknown> {
  return Boolean(item) && typeof item === "object";
}

function extractInputMessages(input: unknown[]) {
  return input
    .filter(isInputRecord)
    .filter((item) => item.type === "message" && item.role === "assistant");
}

function findInput(input: unknown[], type: string) {
  return input.filter(isInputRecord).find((item) => item.type === type);
}

const ZERO_USAGE = createZeroUsageFixture();

function buildReasoningPart(id = "rs_test") {
  return {
    type: "thinking" as const,
    thinking: "internal",
    thinkingSignature: JSON.stringify({
      type: "reasoning",
      id,
      summary: [],
    }),
  };
}

function buildAssistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: ZERO_USAGE,
    stopReason,
    timestamp: Date.now(),
    content,
  };
}

function user(content: string) {
  return { role: "user" as const, content, timestamp: Date.now() };
}

function toolConversation(id: string, content: AssistantMessage["content"]) {
  const toolResult: ToolResultMessage = {
    role: "toolResult",
    toolCallId: id,
    toolName: "noop",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: Date.now(),
  };
  return {
    messages: [
      user("Call noop."),
      buildAssistantMessage(
        [...content, { type: "toolCall", id, name: "noop", arguments: {} }],
        "toolUse",
      ),
      toolResult,
      user("Now reply with ok."),
    ],
    tools: [
      {
        name: "noop",
        description: "no-op",
        parameters: Type.Object({}, { additionalProperties: false }),
      },
    ],
  };
}

async function runAbortedOpenAIResponsesStream(params: {
  messages: Context["messages"];
  tools?: Context["tools"];
  usePolicyReplayDefault?: boolean;
  model?: Model<"openai-responses">;
}) {
  // Abort after payload capture so tests inspect serialization without network I/O.
  const controller = new AbortController();
  controller.abort();
  let payload: Record<string, unknown> | undefined;

  const responseStream = stream(
    params.model ?? buildModel(),
    {
      systemPrompt: "system",
      messages: params.messages,
      ...(params.tools ? { tools: params.tools } : {}),
    },
    {
      apiKey: "test",
      ...(params.usePolicyReplayDefault ? {} : { replayResponsesItemIds: true }),
      signal: controller.signal,
      onPayload: (nextPayload: unknown) => {
        payload = nextPayload as Record<string, unknown>;
      },
    } as never,
  );

  await responseStream.result();
  const input: unknown[] = Array.isArray(payload?.input) ? payload.input : [];
  return {
    input,
    types: input
      .filter(isInputRecord)
      .map((item) => item.type)
      .filter((t): t is string => typeof t === "string"),
  };
}

describe("openai-responses reasoning replay", () => {
  it("omits Responses item ids for storeless custom providers while preserving tool call ids", async () => {
    const { input, types } = await runAbortedOpenAIResponsesStream({
      model: buildStorelessCustomModel(),
      usePolicyReplayDefault: true,
      ...toolConversation("call_storeless|fc_storeless", [
        buildReasoningPart("rs_storeless"),
        {
          type: "text",
          text: "Checking.",
          textSignature: JSON.stringify({ v: 1, id: "msg_storeless", phase: "final_answer" }),
        },
      ]),
    });

    expect(types).toContain("message");
    expect(types).toContain("function_call");
    expect(types).toContain("function_call_output");

    const replayedItemIds = input
      .filter(isInputRecord)
      .filter(
        (item) =>
          ["reasoning", "message", "function_call"].includes(String(item.type)) &&
          typeof item.id === "string",
      );
    expect(replayedItemIds).toEqual([]);

    const functionCall = findInput(input, "function_call");
    const functionCallOutput = findInput(input, "function_call_output");
    expect(functionCall?.call_id).toBeTruthy();
    expect(functionCallOutput?.call_id).toBe(functionCall?.call_id);
  });

  it("replays reasoning for tool-call-only turns (OpenAI requires it)", async () => {
    const { input, types } = await runAbortedOpenAIResponsesStream(
      toolConversation("call_123|fc_123", [buildReasoningPart()]),
    );

    expect(types).toContain("reasoning");
    expect(types).toContain("function_call");
    expect(types.indexOf("reasoning")).toBeLessThan(types.indexOf("function_call"));

    const functionCall = findInput(input, "function_call");
    expect(functionCall?.call_id).toBe("call_123");
    expect(functionCall?.id).toBe("fc_123");
  });

  it.each(["commentary"] as const)(
    "replays assistant message id and phase metadata for %s when paired with reasoning",
    async (phase) => {
      const assistantWithText = buildAssistantMessage([
        buildReasoningPart(),
        {
          type: "text",
          text: "hello",
          textSignature: JSON.stringify({ v: 1, id: `msg_${phase}`, phase }),
        },
      ]);

      const { input, types } = await runAbortedOpenAIResponsesStream({
        messages: [user("Hi"), assistantWithText, user("Ok")],
      });

      expect(types).toContain("message");

      const replayedMessage = extractInputMessages(input).find(
        (item) => item.id === `msg_${phase}`,
      );
      expect(replayedMessage?.phase).toBe(phase);
    },
  );

  it("replays a synthetic id while preserving phase for id-less text signatures", async () => {
    // After a reasoning drop the sanitizer keeps the phase but removes the msg_*
    // id. The conversion must then emit a unique synthetic id per text block AND
    // retain the phase metadata (issue #88019 review follow-up).
    const assistantWithPhaseOnly = buildAssistantMessage([
      {
        type: "text",
        text: "commentary",
        textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
      },
      {
        type: "text",
        text: "final",
        textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
      },
    ]);

    const { input } = await runAbortedOpenAIResponsesStream({
      messages: [user("Hi"), assistantWithPhaseOnly, user("Ok")],
    });

    const messages = extractInputMessages(input);
    const ids = messages.map((item) => item.id);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(2);
    expect(messages.map((item) => item.phase)).toEqual(["commentary", "final_answer"]);
  });
});
