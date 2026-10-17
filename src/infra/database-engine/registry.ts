import type { DatabaseEngineFamily, DatabaseEngineId } from "./types.js";
export type { DatabaseEngineId } from "./types.js";

// Keep schema validation independent of the complete, schema-inferred application config.
type DatabaseEngineConfig = {
  database?: {
    engine?: DatabaseEngineId;
    families?: Partial<
      Record<
        Exclude<DatabaseEngineFamily, "quarantine" | "managed-update" | "package-activation">,
        { engine: DatabaseEngineId }
      >
    >;
  };
};

export type DatabaseEngineStore = {
  id: DatabaseEngineFamily;
  label: string;
  postgres?: boolean;
  diagnosticPath?: (env: NodeJS.ProcessEnv) => Promise<string | null>;
  diagnosticSchemaVersion?: () => Promise<number>;
};

// Store families, including local safety journals, without loading plugin code.
const stores: readonly DatabaseEngineStore[] = [
  { id: "state", label: "Shared state", postgres: true },
  { id: "agent", label: "Agent data", postgres: true },
  { id: "workboard", label: "Workboard", postgres: true },
  { id: "logbook", label: "Logbook", postgres: true },
  { id: "team-reports", label: "Team Reports", postgres: true },
  {
    id: "quarantine",
    label: "Database quarantine",
    async diagnosticSchemaVersion() {
      const { OPENCLAW_QUARANTINE_SCHEMA_VERSION } =
        await import("../../state/openclaw-quarantine-store.js");
      return OPENCLAW_QUARANTINE_SCHEMA_VERSION;
    },
    async diagnosticPath(env) {
      const { resolveQuarantineStorePath } = await import("../../state/openclaw-state-db.paths.js");
      return resolveQuarantineStorePath(env);
    },
  },
  {
    id: "managed-update",
    label: "Managed update handoffs",
    async diagnosticPath() {
      const { resolveManagedUpdateLeaseDatabasePath } =
        await import("../update-managed-service-handoff-lease.js");
      return resolveManagedUpdateLeaseDatabasePath();
    },
  },
  {
    id: "package-activation",
    label: "Package activation journal",
    async diagnosticPath() {
      const { resolveOpenClawPackageRoot } = await import("../openclaw-root.js");
      const { resolvePackageActivationAnchor, resolvePackageActivationJournalPath } =
        await import("../package-update-activation-paths.js");
      const root = await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url });
      return root
        ? resolvePackageActivationJournalPath(resolvePackageActivationAnchor(root))
        : null;
    },
  },
];

export function listDatabaseEngineStores(): readonly DatabaseEngineStore[] {
  return stores;
}

/** Credentials intentionally remain outside the configurable engine families. */
export function listLocalDatabaseDiagnosticStores() {
  return [
    ...stores
      .filter((store) => store.diagnosticPath)
      .map((store) => ({
        id: store.id,
        label: store.label,
        resolvePath: store.diagnosticPath!,
        resolveSchemaVersion: store.diagnosticSchemaVersion,
      })),
    {
      id: "credentials",
      label: "Local credentials",
      async resolveSchemaVersion() {
        const { CLIENT_CREDENTIAL_SCHEMA_VERSION } = await import("../client-credential-schema.js");
        return CLIENT_CREDENTIAL_SCHEMA_VERSION;
      },
      async resolvePath(env: NodeJS.ProcessEnv) {
        const { resolveClientCredentialStorePath } = await import("../client-credential-store.js");
        return resolveClientCredentialStorePath(env);
      },
    },
  ];
}

export function selectDatabaseEngine(
  store: Pick<DatabaseEngineStore, "id" | "postgres">,
  config: DatabaseEngineConfig,
): DatabaseEngineId {
  const override =
    store.id === "quarantine" || store.id === "managed-update" || store.id === "package-activation"
      ? undefined
      : config.database?.families?.[store.id]?.engine;
  if (override === "postgres" && !store.postgres) {
    throw new Error(`database.families.${store.id}.engine does not support postgres.`);
  }
  return (
    override ?? (config.database?.engine === "postgres" && store.postgres ? "postgres" : "sqlite")
  );
}

export function resolveDatabaseFamilyEngines(
  config: DatabaseEngineConfig,
): Record<DatabaseEngineFamily, DatabaseEngineId> {
  const effectiveEngines: Record<DatabaseEngineFamily, DatabaseEngineId> = {
    state: "sqlite",
    agent: "sqlite",
    workboard: "sqlite",
    logbook: "sqlite",
    "team-reports": "sqlite",
    quarantine: "sqlite",
    "managed-update": "sqlite",
    "package-activation": "sqlite",
  };
  for (const store of stores) {
    effectiveEngines[store.id] = selectDatabaseEngine(store, config);
  }
  return effectiveEngines;
}
