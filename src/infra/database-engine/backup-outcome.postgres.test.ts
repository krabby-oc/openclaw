import assert from "node:assert/strict";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { backupRecordCommand } from "../../commands/backup-record.js";
import { createTestRuntime } from "../../commands/test-runtime-config-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { resolveDatabaseEngineSelection } from "./config.js";
import { withDatabaseEngineSelection } from "./context.js";
import { readEngineAnchor } from "./open.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;

describe.skipIf(!connection)("PostgreSQL backup outcome ownership", () => {
  it("resolves the configured engine for an offline CLI outcome after worker bootstrap", async () => {
    assert(connection);
    await withOpenClawTestState(
      { scenario: "minimal", prefix: "pg-backup-outcome-" },
      async (state) => {
        const config: OpenClawConfig = {
          database: { engine: "postgres", postgres: { connection } },
        };
        await state.writeConfig(config);
        const client = new Client({ connectionString: connection });
        let namespace: string | undefined;
        await client.connect();
        try {
          const selection = await resolveDatabaseEngineSelection(config, state.env);
          await withDatabaseEngineSelection(selection, () =>
            executeOpenClawStateWorker(captureOpenClawStateWorkerContext({ env: state.env }), {
              type: "machineState.write",
              input: { key: "backup.fixture", value: true },
            }),
          );
          await closeOpenClawStateDatabaseAsync();
          {
            using database = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(state.env), {
              readOnly: true,
            });
            const anchor = readEngineAnchor(database)?.[0];
            assert(typeof anchor?.schema === "string");
            namespace = anchor.schema;
          }
          const runtime = createTestRuntime();
          await backupRecordCommand(runtime, {
            status: "ok",
            target: "postgres-offline-backup",
            json: true,
          });
          expect(runtime.error).not.toHaveBeenCalled();
          expect(
            (
              await client.query(
                `SELECT status, archive_path FROM "${namespace}".backup_runs WHERE archive_path = $1`,
                ["postgres-offline-backup"],
              )
            ).rows,
          ).toEqual([{ status: "ok", archive_path: "postgres-offline-backup" }]);
        } finally {
          await closeOpenClawStateDatabaseAsync();
          if (namespace) {
            await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
          }
          await client.end();
        }
      },
    );
  });
});
