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

const reasoningFields = ["reasoning_details", "reasoning", "reasoning_text"];
const allReasoningFields = [...reasoningFields, "reasoning_content"];

function expectAbsent(assistant: unknown, fields = reasoningFields) {
  for (const field of fields) {
    expect(assistant).not.toHaveProperty(field);
  }
}

function toolReplay(model: string, stopReason: string, content: unknown[], toolName: string) {
  return buildOpenAICompletionsParams(
    openRouterModel,
    {
      systemPrompt: "system",
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          provider: "openrouter",
          api: "openai-completions",
          model,
          stopReason,
          timestamp: 0,
          content,
        },
        makeTextToolResult("call_1", toolName, "ok", false, 1),
        { role: "user", content: "again" },
      ],
      tools: [],
    } as never,
    undefined,
  ) as { messages: Array<Record<string, unknown>> };
}

describe("buildOpenAICompletionsParams sanitizes reasoning replay fields", () => {
  it("strips reasoning_text from stock OpenAI assistant replay", () => {
    const assistant = getAssistantMessage(buildReplayParams(openAIModel, "reasoning_text"));

    expectAbsent(assistant, allReasoningFields);
  });

  it.each(["reasoning_details", "reasoning_text"])(
    "normalizes OpenRouter %s to reasoning",
    (field) => {
      const assistant = getAssistantMessage(buildReplayParams(openRouterModel, field));
      expect(assistant).not.toHaveProperty(field);
      expect(assistant.reasoning).toBe("Need to answer politely.");
    },
  );

  it.each([
    ["Anthropic", openRouterAnthropicModel],
    ["xAI", openRouterXaiModel],
  ] as const)("strips OpenRouter %s non-replayable reasoning fields", (_label, model) => {
    for (const thinkingSignature of allReasoningFields) {
      const assistant = getAssistantMessage(buildReplayParams(model, thinkingSignature));

      expectAbsent(assistant, allReasoningFields);
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
    );

    const assistantMessages = params.messages.filter((msg) => msg.role === "assistant");
    for (const msg of assistantMessages) {
      expect(msg).not.toHaveProperty("reasoning_content");
    }
  });

  it("preserves native Z.AI reasoning_content replay", () => {
    const assistant = getAssistantMessage(buildReplayParams(nativeZaiModel, "reasoning_content"));

    expect(assistant.reasoning_content).toBe("Need to answer politely.");
  });

  it("strips non-native DeepSeek reasoning replay fields", () => {
    const assistant = getAssistantMessage(
      buildReplayParams(nativeDeepSeekModel, "reasoning_details"),
    );

    expectAbsent(assistant);
  });

  it.each([
    ["custom reasoning metadata", customQwenReasoningModel, true],
    ["Xiaomi MiMo", xiaomiModel, true],
    ["stale Kimi metadata", staleKimiK27Model, true],
    [
      "suffixed model id",
      { ...customMiMoProxyModel, id: "xiaomi/mimo-v2.5-pro:cloud", reasoning: false },
      false,
    ],
    [
      "prefixed model id",
      { ...customKimiProxyModel, id: "hf:moonshotai/kimi-k2-thinking", reasoning: false },
      false,
    ],
  ] as const)("preserves reasoning_content for %s", (_label, model, assertSanitizedFields) => {
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
