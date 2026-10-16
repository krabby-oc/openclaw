import type { DatabaseSync } from "node:sqlite";
import { stripPluginModelCatalogCredentials } from "../agents/plugin-model-catalog-repair.js";
import { quoteSqliteIdentifier as quote } from "../infra/sqlite-schema-sql.js";
import {
  AGENT_SECRET_TABLE_NAMES,
  STATE_SECRET_CONFIG_STATE_KEY_PREFIXES,
  STATE_SECRET_TABLE_NAMES,
} from "../state/secret-state-tables.js";
import type { SnapshotDatabaseIdentity } from "./snapshot-provider.js";

type RedactionIdentity = Pick<SnapshotDatabaseIdentity, "role">;
const modelCatalogScopes = ["plugin-model-catalog-v1", "plugin-model-catalog-migration-v1"];

function resolveRedactionIdentity(
  identity: RedactionIdentity,
  postgresFamily?: string,
): RedactionIdentity {
  // A retained store's Git scope need not be its database family (for example Matrix state).
  return {
    role:
      postgresFamily === "state" ? "global" : postgresFamily === "agent" ? "agent" : identity.role,
  };
}

export function gitBackupRedaction(
  identity: RedactionIdentity,
  tables: ReadonlySet<string>,
  excludeSecrets: boolean,
  postgresFamily?: string,
) {
  const owner = resolveRedactionIdentity(identity, postgresFamily);
  const secretTables =
    owner.role === "global" ? STATE_SECRET_TABLE_NAMES : AGENT_SECRET_TABLE_NAMES;
  return {
    excludedTables: excludeSecrets
      ? secretTables.filter((table) => tables.has(table)).toSorted()
      : [],
    excludedConfigStateKeyPrefixes:
      excludeSecrets && owner.role === "global" && tables.has("config_machine_state")
        ? [...STATE_SECRET_CONFIG_STATE_KEY_PREFIXES]
        : [],
  };
}

/** Shared by serialized SQLite rows and the portable PostgreSQL image. */
export function redactGitBackupRow(
  table: string,
  row: Record<string, unknown>,
  identity: RedactionIdentity,
  prefixes: readonly string[],
): boolean {
  if (table === "config_machine_state" && prefixes.length > 0) {
    const stateKey = row.state_key;
    // Malformed keys cannot establish that the row is outside the secret scopes.
    if (typeof stateKey !== "string" || prefixes.some((prefix) => stateKey.startsWith(prefix))) {
      return false;
    }
  }
  if (
    identity.role === "agent" &&
    table === "cache_entries" &&
    modelCatalogScopes.some((scope) => row.scope === scope) &&
    typeof row.value_json === "string"
  ) {
    row.value_json = stripPluginModelCatalogCredentials(row.value_json);
    return row.value_json !== null;
  }
  return true;
}

/** Keep the provider's schema intact while removing all credential-bearing content. */
export function sanitizeGitBackupImage(
  database: DatabaseSync,
  identity: RedactionIdentity,
  postgresFamily: string,
) {
  const owner = resolveRedactionIdentity(identity, postgresFamily);
  const tables = new Set(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name)),
  );
  const redaction = gitBackupRedaction(owner, tables, true);
  // Unlike JSONL exports, the portable image includes free pages. Erase replaced
  // content without VACUUM changing the provider's preserved implicit row IDs.
  database.exec("PRAGMA secure_delete = ON");
  for (const table of redaction.excludedTables) {
    database.prepare(`DELETE FROM ${quote(table)}`).run();
  }
  if (redaction.excludedConfigStateKeyPrefixes.length) {
    database.prepare("DELETE FROM config_machine_state WHERE typeof(state_key) <> 'text'").run();
    const remove = database.prepare(
      "DELETE FROM config_machine_state WHERE substr(state_key, 1, ?) = ?",
    );
    for (const prefix of redaction.excludedConfigStateKeyPrefixes) {
      remove.run(prefix.length, prefix);
    }
  }
  if (owner.role === "agent" && tables.has("cache_entries")) {
    const read = database.prepare(
      "SELECT key, value_json FROM cache_entries WHERE scope = ? AND (? IS NULL OR key > ?) ORDER BY key LIMIT 64",
    );
    const remove = database.prepare("DELETE FROM cache_entries WHERE scope = ? AND key = ?");
    const update = database.prepare(
      "UPDATE cache_entries SET value_json = ? WHERE scope = ? AND key = ?",
    );
    for (const scope of modelCatalogScopes) {
      let after: string | null = null;
      for (;;) {
        const rows: ReturnType<typeof read.all> = read.all(scope, after, after);
        if (rows.length === 0) {
          break;
        }
        for (const source of rows) {
          if (typeof source.value_json !== "string") {
            continue;
          }
          const key = String(source.key);
          const redacted = stripPluginModelCatalogCredentials(source.value_json);
          if (redacted === null) {
            remove.run(scope, key);
          } else if (redacted !== source.value_json) {
            update.run(redacted, scope, key);
          }
        }
        after = String(rows.at(-1)!.key);
      }
    }
  }
}
