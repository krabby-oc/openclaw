import { vi } from "vitest";

vi.mock("../../agent-tool-definition-adapter.js", async (importOriginal) => {
  const {
    CLIENT_TOOL_NAME_CONFLICT_PREFIX,
    findClientToolNameConflicts,
    isClientToolNameConflictError,
    toClientToolDefinitions,
  } = await importOriginal<typeof import("../../agent-tool-definition-adapter.js")>();
  return {
    CLIENT_TOOL_NAME_CONFLICT_PREFIX,
    findClientToolNameConflicts,
    isClientToolNameConflictError,
    toClientToolDefinitions,
    toToolDefinitions: (tools: unknown[]) => tools,
  };
});
