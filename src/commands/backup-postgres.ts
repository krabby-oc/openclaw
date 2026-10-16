import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import * as tar from "tar";
import { readEngineAnchor } from "../infra/database-engine/open.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { PostgresExportEnvelope } from "../snapshot/export-envelope.js";
import { BACKUP_MAX_DECOMPRESSION_RATIO } from "./backup-shared.js";

type ArchiveEntry = { raw: string; normalized: string; type?: string; size?: number };

export type BackupPostgresSnapshot = {
  anchorArchivePath: string;
  directoryArchivePath: string;
};

/** Matched exports are identified by their archive-owned capsule and companion anchor. */
export function resolveBackupPostgresSnapshots(entries: ArchiveEntry[]): BackupPostgresSnapshot[] {
  const directories = new Set<string>();
  for (const entry of entries) {
    if (/\.postgres\/(?:manifest\.json|anchor\.sqlite|database\.sqlite)$/u.test(entry.normalized)) {
      directories.add(path.posix.dirname(entry.normalized));
    }
  }
  return [...directories].map((directoryArchivePath) => ({
    anchorArchivePath: directoryArchivePath.slice(0, -".postgres".length),
    directoryArchivePath,
  }));
}

/** Naming alone cannot claim unrelated workspace files as database exports. */
async function isBackupPostgresSnapshot(
  root: string,
  snapshot: BackupPostgresSnapshot,
  byPath: ReadonlyMap<string, ArchiveEntry>,
): Promise<boolean> {
  const regular = (entry: ArchiveEntry | undefined) =>
    Boolean(entry && ["File", "OldFile", "ContiguousFile"].includes(entry.type ?? ""));
  let postgres = false;
  if (regular(byPath.get(snapshot.anchorArchivePath))) {
    const anchorPath = path.join(root, snapshot.anchorArchivePath);
    const handle = await fs.open(anchorPath, "r");
    try {
      const header = Buffer.alloc(16);
      await handle.read(header, 0, header.length, 0);
      if (header.toString("utf8") === "SQLite format 3\0") {
        try {
          using anchor = openNodeSqliteDatabase(anchorPath, { readOnly: true });
          postgres = readEngineAnchor(anchor) !== undefined;
        } catch {
          // Opaque workspace databases need not have readable SQLite schemas.
        }
      }
    } finally {
      await handle.close();
    }
  }
  const manifestEntry = byPath.get(path.posix.join(snapshot.directoryArchivePath, "manifest.json"));
  if (!postgres && regular(manifestEntry) && (manifestEntry?.size ?? 0) <= 1024 * 1024) {
    try {
      const manifest: unknown = JSON.parse(
        await fs.readFile(path.join(root, snapshot.directoryArchivePath, "manifest.json"), "utf8"),
      );
      postgres =
        isRecord(manifest) &&
        manifest.schemaVersion === 2 &&
        isRecord(manifest.source) &&
        manifest.source.engine === "postgres";
    } catch {
      // An unrelated opaque manifest need not contain JSON.
    }
  }
  if (!postgres) {
    return false;
  }
  for (const member of backupPostgresSnapshotMembers(snapshot)) {
    const file = byPath.get(member);
    if (!regular(file) || !Number.isSafeInteger(file?.size) || (file?.size ?? 0) <= 0) {
      throw new Error(`PostgreSQL backup requires a regular matched artifact: ${member}`);
    }
  }
  return true;
}

export function backupPostgresSnapshotMembers(snapshot: BackupPostgresSnapshot): string[] {
  return [
    snapshot.anchorArchivePath,
    ...["manifest.json", "anchor.sqlite", "database.sqlite"].map((name) =>
      path.posix.join(snapshot.directoryArchivePath, name),
    ),
  ];
}

/** Extract and classify candidate capsules once, under the archive owner's capacity budget. */
export async function prepareBackupPostgresSnapshots(params: {
  archivePath: string;
  tempDir: string;
  entries: ArchiveEntry[];
  candidates: BackupPostgresSnapshot[];
  assertCapacity: (entries: ArchiveEntry[]) => void;
}) {
  const members = new Set(params.candidates.flatMap(backupPostgresSnapshotMembers));
  const entries = params.entries.filter(
    (entry) =>
      members.has(entry.normalized) &&
      ["File", "OldFile", "ContiguousFile"].includes(entry.type ?? ""),
  );
  const snapshots: BackupPostgresSnapshot[] = [];
  if (entries.length > 0) {
    params.assertCapacity(entries);
    const entryPaths = new Set(entries.map((entry) => entry.raw));
    await tar.x({
      file: params.archivePath,
      gzip: true,
      maxDecompressionRatio: BACKUP_MAX_DECOMPRESSION_RATIO,
      cwd: params.tempDir,
      strict: true,
      preserveOwner: false,
      filter: (entryPath) => entryPaths.has(entryPath),
    });
    const byPath = new Map(params.entries.map((entry) => [entry.normalized, entry]));
    for (const snapshot of params.candidates) {
      if (await isBackupPostgresSnapshot(params.tempDir, snapshot, byPath)) {
        await verifyBackupPostgresSnapshot(params.tempDir, snapshot);
        snapshots.push(snapshot);
      }
    }
  }
  return {
    entries,
    members,
    snapshots,
    byAnchor: new Map(snapshots.map((snapshot) => [snapshot.anchorArchivePath, snapshot])),
  };
}

/** Role checks read application tables from the verified export, never a PG anchor. */
export function openBackupSnapshotImage(
  root: string,
  archivePath: string,
  snapshots: ReadonlyMap<string, BackupPostgresSnapshot>,
): DatabaseSync {
  const open = (pathname: string) => {
    const database = openNodeSqliteDatabase(pathname, { allowExtension: true, readOnly: true });
    try {
      database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  };
  const database = open(path.join(root, archivePath));
  try {
    if (!readEngineAnchor(database)) {
      return database;
    }
    const snapshot = snapshots.get(archivePath);
    if (!snapshot) {
      throw new Error("PostgreSQL anchor is missing its matched export.");
    }
    const image = open(path.join(root, snapshot.directoryArchivePath, "database.sqlite"));
    database.close();
    return image;
  } catch (error) {
    database.close();
    throw error;
  }
}

/** Verification is local and never reconnects an archived anchor to its source server. */
export async function verifyBackupPostgresSnapshot(
  root: string,
  snapshot: BackupPostgresSnapshot,
): Promise<PostgresExportEnvelope> {
  const { verifyMatchedPostgresBackup } = await import("../snapshot/database-backup.js");
  const directory = path.join(root, snapshot.directoryArchivePath);
  const manifest = await verifyMatchedPostgresBackup(directory, "user-backup");
  const [publishedAnchor, matchedAnchor] = await Promise.all([
    fs.readFile(path.join(root, snapshot.anchorArchivePath)),
    fs.readFile(path.join(directory, "anchor.sqlite")),
  ]);
  if (!publishedAnchor.equals(matchedAnchor)) {
    throw new Error(
      `PostgreSQL archive anchor differs from its matched export: ${snapshot.anchorArchivePath}`,
    );
  }
  return manifest;
}

/** Prepare fresh server namespaces, replacing only anchors inside the private restored tree. */
export async function restoreBackupPostgresSnapshots(
  targetPath: string,
  snapshots: BackupPostgresSnapshot[],
): Promise<void> {
  if (snapshots.length === 0) {
    return;
  }
  const { preparePostgresRestore, runOfflineDatabaseBackup } =
    await import("../snapshot/database-backup.js");
  await runOfflineDatabaseBackup(
    path.join(targetPath, snapshots[0]!.anchorArchivePath),
    async ({ config, assertCurrent }) => {
      const prepared = new Map<string, string>();
      for (const snapshot of snapshots) {
        const directory = path.join(targetPath, snapshot.directoryArchivePath);
        const { source } = await verifyBackupPostgresSnapshot(targetPath, snapshot);
        const identity = `${source.storeId}:${source.namespace}`;
        const target = path.join(targetPath, snapshot.anchorArchivePath);
        const previous = prepared.get(identity);
        assertCurrent();
        if (previous) {
          await fs.copyFile(previous, target);
          continue;
        }
        const staging = `${target}.restore-${randomUUID()}`;
        try {
          await preparePostgresRestore({
            directory,
            anchorPath: staging,
            config,
            profile: "user-backup",
            assertCurrent,
          });
          assertCurrent();
          await fs.rename(staging, target);
          prepared.set(identity, target);
        } finally {
          await fs.rm(staging, { force: true });
        }
      }
    },
  );
}
