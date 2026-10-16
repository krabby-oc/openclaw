import fs from "node:fs/promises";
import path from "node:path";
import type { InternalSessionEntry } from "../../config/sessions.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";

export function createRestartRecoveryAdmissionFixture(getStateDir: () => string) {
  async function makeMainSessionFixture(
    overrides: Partial<InternalSessionEntry> & { agentId?: string; sessionKey?: string } = {},
  ) {
    const { agentId = "main", sessionKey = "agent:main:main", ...entry } = overrides;
    const sessionsDir = path.join(getStateDir(), "agents", agentId, "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    await fs.mkdir(sessionsDir, { recursive: true });
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "main-session",
        permissionMode: "guarded",
        updatedAt: Date.now() - 10_000,
        status: "interrupted",
        abortedLastRun: true,
        mainRestartRecovery: { cycleId: "interrupted-cycle", revision: 1, chargedAttempts: 0 },
        ...entry,
      },
    );
    return { sessionsDir, storePath, sessionKey };
  }

  async function writeCompletedToolTranscript(sessionsDir: string) {
    for (const message of [
      { role: "user", content: "run the tool" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]) {
      await appendTranscriptMessage(
        {
          sessionId: "main-session",
          sessionKey: "agent:main:main",
          storePath: path.join(sessionsDir, "sessions.json"),
        },
        { message, cwd: sessionsDir },
      );
    }
  }

  return { makeMainSessionFixture, writeCompletedToolTranscript };
}
