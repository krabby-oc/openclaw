import { describe, expect, it } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import {
  openRouterModel,
  openRouterAnthropicModel,
  openRouterXaiModel,
  openAIModel,
  nativeDeepSeekModel,
  nativeZaiModel,
  xiaomiModel,
  customMiMoProxyModel,
  customKimiProxyModel,
  staleKimiK27Model,
  customQwenReasoningModel,
  customReasoningProxyModel,
  getAssistantMessage,
  buildReplayParams,
  makeCompletionsModel,
} from "./openai-completions.test-support.js";
import { getCompat } from "./openai-transport-params.js";

function expectAbsent(
  assistant: unknown,
  fields = ["reasoning_details", "reasoning", "reasoning_text"],
) {
  for (const field of fields) {
    expect(assistant).not.toHaveProperty(field);
  }
}

function toolReplay(
  model: string,
  stopReason: string,
  content: unknown[],
  toolName: string,
  result: string,
  user: string,
  next: string,
) {
  return buildOpenAICompletionsParams(
    openRouterModel,
    {
      systemPrompt: "system",
      messages: [
        { role: "user", content: user },
        {
          role: "assistant",
          provider: "openrouter",
          api: "openai-completions",
          model,
          stopReason,
          timestamp: 0,
          content,
        },
        makeTextToolResult("call_1", toolName, result, false, 1),
        { role: "user", content: next },
      ],
      tools: [],
    } as never,
    undefined,
  ) as { messages: Array<Record<string, unknown>> };
}

describe("buildOpenAICompletionsParams sanitizes reasoning replay fields", () => {
  it.each(["reasoning_text"])(
    "strips %s from stock OpenAI Chat Completions assistant replay",
    (thinkingSignature) => {
      const assistant = getAssistantMessage(buildReplayParams(openAIModel, thinkingSignature));

      expectAbsent(assistant, [
        "reasoning_details",
        "reasoning_content",
        "reasoning",
        "reasoning_text",
      ]);
    },
  );

  it("normalizes OpenRouter string reasoning_details to reasoning", () => {
    const assistant = getAssistantMessage(buildReplayParams(openRouterModel, "reasoning_details"));

    expect(assistant).not.toHaveProperty("reasoning_details");
    expect(assistant.reasoning).toBe("Need to answer politely.");
  });

  it.each([
    ["Anthropic", openRouterAnthropicModel],
    ["xAI", openRouterXaiModel],
  ] as const)("strips OpenRouter %s non-replayable reasoning fields", (_label, model) => {
    for (const thinkingSignature of [
      "reasoning_details",
      "reasoning_content",
      "reasoning",
      "reasoning_text",
    ]) {
      const assistant = getAssistantMessage(buildReplayParams(model, thinkingSignature));

      expectAbsent(assistant, [
        "reasoning_details",
        "reasoning_content",
        "reasoning",
        "reasoning_text",
      ]);
    }
  });

  it("strips empty-string reasoning_content from OpenRouter assistant replay", () => {
    const params = toolReplay(
      "deepseek/deepseek-v4-pro",
      "toolUse",
      [
        { type: "thinking", thinking: "", thinkingSignature: "reasoning_content" },
        { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "config.json" } },
      ],
      "read_file",
      "{ }",
      "read config",
      "continue",
    );

    const assistantMessages = params.messages.filter((msg) => msg.role === "assistant");
    for (const msg of assistantMessages) {
      expect(msg).not.toHaveProperty("reasoning_content");
    }
  });

  it.each([["Z.AI", nativeZaiModel]] as const)(
    "preserves native %s reasoning_content replay",
    (_label, model) => {
      const assistant = getAssistantMessage(buildReplayParams(model, "reasoning_content"));

      expect(assistant.reasoning_content).toBe("Need to answer politely.");
    },
  );

  it.each([["DeepSeek", nativeDeepSeekModel]] as const)(
    "strips non-native %s reasoning replay fields",
    (_label, model) => {
      const assistant = getAssistantMessage(buildReplayParams(model, "reasoning_details"));

      expectAbsent(assistant);
    },
  );

  it("normalizes OpenRouter reasoning_text to reasoning", () => {
    const assistant = getAssistantMessage(buildReplayParams(openRouterModel, "reasoning_text"));

    expect(assistant).not.toHaveProperty("reasoning_text");
    expect(assistant.reasoning).toBe("Need to answer politely.");
  });

  it.each([
    {
      label: "preserves reasoning_content replay for custom reasoning model metadata",
      model: customQwenReasoningModel,
      assertSanitizedFields: true,
    },
    {
      label: "preserves DeepSeek-style reasoning_content replay for Xiaomi MiMo",
      model: xiaomiModel,
      assertSanitizedFields: true,
    },
    {
      label: "preserves Kimi K2.7 reasoning_content replay with stale reasoning metadata",
      model: staleKimiK27Model,
      assertSanitizedFields: true,
    },
    {
      label: "preserves reasoning_content replay for suffixed reasoning model ids",
      model: { ...customMiMoProxyModel, id: "xiaomi/mimo-v2.5-pro:cloud", reasoning: false },
      assertSanitizedFields: false,
    },
    {
      label: "preserves reasoning_content replay for prefixed reasoning model ids",
      model: { ...customKimiProxyModel, id: "hf:moonshotai/kimi-k2-thinking", reasoning: false },
      assertSanitizedFields: false,
    },
  ] as const)("$label", ({ model, assertSanitizedFields }) => {
    const assistant = getAssistantMessage(buildReplayParams(model, "reasoning_content"));

    expect(assistant.reasoning_content).toBe("Need to answer politely.");
    if (assertSanitizedFields) {
      expectAbsent(assistant);
    }
  });

  // #87575: the tier suffix must not strip reasoning_content and cause HTTP 400.
  it("preserves reasoning_content replay despite the OpenCode Zen free tier suffix", () => {
    const model = makeCompletionsModel({
      id: "deepseek-v4-flash-free",
      name: "DeepSeek V4 Flash Free",
      provider: "opencode",
      baseUrl: "https://opencode.ai/zen/v1",
      reasoning: false,
      contextWindow: 65_536,
      maxTokens: 8192,
    });
    const assistant = getAssistantMessage(buildReplayParams(model, "reasoning_content"));

    expect(assistant.reasoning_content).toBe("Need to answer politely.");
    expectAbsent(assistant);
  });

  it("preserves OpenRouter array reasoning_details from tool-call signatures", () => {
    const reasoningDetail = { type: "reasoning.encrypted", id: "rs_1", data: "ciphertext" };
    const params = toolReplay(
      "deepseek/deepseek-v4-flash",
      "stop",
      [
        {
          type: "toolCall",
          id: "call_1",
          name: "lookup",
          arguments: { query: "weather" },
          thoughtSignature: JSON.stringify(reasoningDetail),
        },
      ],
      "lookup",
      "sunny",
      "lookup",
      "answer",
    );

    const assistant = getAssistantMessage(params);
    expect(assistant.reasoning_details).toEqual([reasoningDetail]);
  });

  it("honors compat.requiresReasoningContentOnAssistantMessages from config on a custom provider (#89660)", () => {
    const resolved = getCompat({
      ...customReasoningProxyModel,
      compat: { requiresReasoningContentOnAssistantMessages: true },
    } as never);

    expect(resolved.requiresReasoningContentOnAssistantMessages).toBe(true);
  });
});
