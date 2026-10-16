import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  extractWorkerBundleArchive,
  DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
} from "../../shared/worker-bundle-archive.js";
import * as stateDb from "../../state/openclaw-state-db.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import * as bundleStaging from "./bundle-staging.js";
import {
  createWorkerBundleProducer,
  resolveWorkerNpmInstallationArtifact,
  type WorkerInstallationArtifact,
} from "./bundle.js";
import { createWorkerPreparationIdentity } from "./preparation-identity.js";
import { createWorkerEnvironmentStore } from "./store.js";
import { listRetainedWorkerBundleHashes } from "./worker-bundle-retention.js";
import { workerWorkspaceRsyncReceiverEntryPath } from "./workspace-sync-helpers.js";

type WorkerBundleArtifact = Extract<WorkerInstallationArtifact, { install: "bundle" }>;

const artifactSources = {
  "code-mode-node.worker.mjs": "export const codeModeNode = true;\n",
  "file-tool-planning.worker.mjs": "export const fileToolPlanning = true;\n",
  "file-tool-read.worker.mjs": "export const fileToolRead = true;\n",
  "gateway-state-owner-heartbeat.worker.mjs": "export const heartbeat = true;\n",
  "github-exec-launcher.mjs": "export const launcher = true;\n",
  "image-processor.worker.mjs": "export const imageProcessor = true;\n",
  "openclaw-state-read.worker.mjs": "export const stateRead = true;\n",
  "service-child-group-anchor.mjs": "export const anchor = true;\n",
  "service-child-relay.mjs": "export const relay = true;\n",
  "sqlite-source-revision.worker.mjs": "export const sqliteSourceRevision = true;\n",
  "sqlite-store.worker.mjs": "export const sqliteStore = true;\n",
  "windows-security-helper.exe": "MZ\0worker-permission-helper",
  "worker-native-lifecycle.worker.mjs": "export const nativeLifecycle = true;\n",
  "worker.mjs": "export const worker = true;\n",
  "workspace-rsync-receiver.mjs": "export const receiver = true;\n",
};
const artifactNames = Object.keys(artifactSources);
const packageMetadata = `${JSON.stringify({ name: "openclaw", version: "1.2.3" })}\n`;
const workerSource = artifactSources["worker.mjs"];

function writeWorker(packageRoot: string, source: string, artifact = "worker.mjs") {
  return fs.writeFile(path.join(packageRoot, "dist/worker", artifact), source);
}

async function writeFixture(packageRoot: string, source = workerSource) {
  await fs.mkdir(path.join(packageRoot, "dist", "worker"), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "package.json"), packageMetadata);
  for (const [artifactName, contents] of Object.entries({
    ...artifactSources,
    "worker.mjs": source,
  })) {
    await fs.writeFile(path.join(packageRoot, "dist", "worker", artifactName), contents, {
      encoding: "utf8",
      mode: 0o755,
    });
  }
}

async function listTarball(tarballPath: string): Promise<string[]> {
  const entries: string[] = [];
  await tar.list({
    file: tarballPath,
    onReadEntry: (entry) => entries.push(entry.path),
  });
  return entries;
}

function withFixture(
  run: (fixture: {
    root: string;
    packageRoot: string;
    cacheDir: string;
    producer: typeof createWorkerBundleProducer;
  }) => Promise<void>,
  source?: string | false,
) {
  return withTestDir({ prefix: "openclaw-worker-bundle-" }, async (root) => {
    const packageRoot = path.join(root, "package");
    const cacheDir = path.join(root, "cache");
    if (source !== false) {
      await writeFixture(packageRoot, source);
    }
    await run({
      root,
      packageRoot,
      cacheDir,
      producer: (options = {}) => createWorkerBundleProducer({ packageRoot, cacheDir, ...options }),
    });
  });
}

function bundleArtifact(overrides: Partial<WorkerBundleArtifact> = {}): WorkerBundleArtifact {
  return {
    install: "bundle",
    bundleHash: "a".repeat(64),
    openclawVersion: "1.2.3",
    protocolFeatures: [],
    tarballBytes: 1,
    tarballSha256: "b".repeat(64),
    tarballPath: "/tmp/openclaw-worker.tgz",
    ...overrides,
  };
}

describe("worker bundle producer", () => {
  it("stages many chunks deterministically", async () => {
    await withTestDir({ prefix: "openclaw-worker-chunks-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      await writeFixture(packageRoot, 'export { value } from "./worker-chunk-0.mjs";', 48);
      const chunk = path.join(packageRoot, "dist/worker/worker-chunk-0.mjs");
      const first = await createWorkerBundleProducer({
        packageRoot,
        cacheDir: path.join(root, "cache"),
      }).prepare();
      const second = await createWorkerBundleProducer({
        packageRoot,
        cacheDir: path.join(root, "second-cache"),
      }).prepare();
      expect(second.bundleHash).toBe(first.bundleHash);
      expect(second.tarballSha256).toBe(first.tarballSha256);
      expect(await listTarball(first.tarballPath)).toContain("worker-chunk-0.mjs");
      const destination = path.join(root, "installed");
      await extractWorkerBundleArchive({
        tarballPath: first.tarballPath,
        destination,
        expectedBundleHash: first.bundleHash,
        limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
      });
      expect(await fs.readFile(path.join(destination, "worker-chunk-0.mjs"), "utf8")).toBe(
        "export const value = 0;\n",
      );
      await fs.writeFile(chunk, "export const value = 2;");
      const changed = await createWorkerBundleProducer({
        packageRoot,
        cacheDir: path.join(root, "cache"),
      }).prepare();
      expect(changed.bundleHash).not.toBe(first.bundleHash);
    });
  });

  it("reuses the sealed worker graph from an installed npm package", async () => {
    await withFixture(async ({ root, packageRoot, producer }) => {
      await writeWorker(packageRoot, "export const value = 1;", "worker-chunk-runtime.mjs");
      const built = await producer().prepare();

      const installedRoot = path.join(root, "installed");
      const archivePath = path.join("dist/worker-artifacts", `${built.bundleHash}.tar.gz`);
      const packagedArchive = path.join(installedRoot, archivePath);
      await fs.mkdir(path.dirname(packagedArchive), { recursive: true });
      await fs.writeFile(path.join(installedRoot, "package.json"), packageMetadata);
      await fs.copyFile(built.tarballPath, packagedArchive);

      const installed = await producer({
        packageRoot: installedRoot,
        cacheDir: path.join(root, "installed-cache"),
      }).prepare();
      expect(installed).toMatchObject({
        bundleHash: built.bundleHash,
        tarballPath: packagedArchive,
        tarballSha256: built.tarballSha256,
      });
      await expect(fs.stat(path.join(root, "installed-cache"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const installedAlias = path.join(root, "installed-alias");
      await fs.symlink(installedRoot, installedAlias, "junction");
      const throughAlias = await producer({
        packageRoot: installedAlias,
        cacheDir: path.join(root, "alias-cache"),
      }).prepare();
      expect(throughAlias).toMatchObject({
        bundleHash: built.bundleHash,
        tarballPath: path.join(installedAlias, archivePath),
      });
    }, 'export { value } from "./worker-chunk-runtime.mjs";');
  });

  it("hashes and archives only the dedicated deploy artifacts", async () => {
    await withFixture(async ({ root, packageRoot: packageA, producer }) => {
      const packageB = path.join(root, "package-b");
      await writeFixture(packageB);
      await fs.mkdir(path.join(packageA, "dist", "control-ui"), { recursive: true });
      await fs.writeFile(path.join(packageA, "dist", "entry.js"), 'import "json5";\n');
      await fs.writeFile(
        path.join(packageA, "dist", "control-ui", "index.html"),
        "<main>UI</main>",
      );
      for (const [packageRoot, timestamp] of [
        [packageA, 1_000],
        [packageB, 9_000],
      ] as const) {
        const date = new Date(timestamp);
        await fs.utimes(path.join(packageRoot, "dist/worker/worker.mjs"), date, date);
      }

      const first = await producer({ openclawVersion: "1.2.3" }).prepare();
      const second = await producer({
        packageRoot: packageB,
        cacheDir: path.join(root, "cache-b"),
        openclawVersion: "1.2.3",
      }).prepare();
      expect(first.bundleHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(second.bundleHash).toBe(first.bundleHash);
      const compressed = await fs.readFile(first.tarballPath);
      expect(first.tarballSha256).toBe(createHash("sha256").update(compressed).digest("hex"));
      expect(first.tarballBytes).toBe(compressed.byteLength);
      const entries = await listTarball(first.tarballPath);
      expect(entries).toEqual(artifactNames);
      const installPrefix = `.openclaw-worker/${first.bundleHash}/`;
      const receiverPath = workerWorkspaceRsyncReceiverEntryPath(first.bundleHash);
      expect(receiverPath.startsWith(installPrefix)).toBe(true);
      expect(entries).toContain(receiverPath.slice(installPrefix.length));
      const extractRoot = path.join(root, "extract");
      await fs.mkdir(extractRoot);
      await tar.extract({ file: first.tarballPath, cwd: extractRoot });
      for (const [artifactName, expectedContents] of Object.entries(artifactSources)) {
        if (["code-mode-node.worker.mjs", "windows-security-helper.exe"].includes(artifactName)) {
          continue;
        }
        const file = path.join(extractRoot, artifactName);
        await expect(fs.readFile(file, "utf8")).resolves.toBe(expectedContents);
        if (process.platform !== "win32") {
          expect((await fs.stat(file)).mode & 0o777).toBe(0o700);
        }
      }
      await expect(fs.access(path.join(extractRoot, "package.json"))).rejects.toThrow();
      await expect(fs.access(path.join(extractRoot, "node_modules"))).rejects.toThrow();
    });
  });

  it("changes identity only when the deploy artifact changes", async () => {
    await withFixture(async ({ packageRoot, producer }) => {
      const first = await producer().prepare();

      await fs.writeFile(path.join(packageRoot, "dist/entry.js"), "export const unrelated = 2;\n");
      const unrelated = await producer().prepare();
      expect(unrelated.bundleHash).toBe(first.bundleHash);

      let previousHash = first.bundleHash;
      for (const artifactName of artifactNames.filter(
        (name) => name !== "code-mode-node.worker.mjs",
      )) {
        await writeWorker(packageRoot, "export const changed = true;\n", artifactName);
        const changed = await producer().prepare();
        expect(changed.bundleHash, artifactName).not.toBe(previousHash);
        previousHash = changed.bundleHash;
      }
    }, "export const value = 1;\n");
  });

  it("packages hardlinked artifacts larger than the default file-read limit", async () => {
    await withTestDir({ prefix: "openclaw-worker-bundle-large-" }, async (root) => {
      const packageRoot = path.join(root, "package");
      const padding = "x".repeat(128);
      const contents = Array.from(
        { length: 128 * 1024 },
        (_, index) => `//${index}:${padding}\n`,
      ).join("");
      await writeFixture(packageRoot, contents);
      await fs.link(
        path.join(packageRoot, "dist", "worker", "worker.mjs"),
        path.join(root, "source-alias.mjs"),
      );

      const artifact = await createWorkerBundleProducer({
        packageRoot,
        cacheDir: path.join(root, "cache"),
      }).prepare();
      const extractDir = path.join(root, "extract");
      await fs.mkdir(extractDir);
      await tar.extract({ file: artifact.tarballPath, cwd: extractDir });

      await expect(fs.readFile(path.join(extractDir, "worker.mjs"), "utf8")).resolves.toBe(
        contents,
      );
      if (process.platform !== "win32") {
        expect((await fs.stat(path.join(extractDir, "worker.mjs"))).mode & 0o777).toBe(0o700);
      }
    });
  });

  it("skips retention reads when the cache has no cleanup candidates", async () => {
    await withFixture(async ({ cacheDir, producer }) => {
      const owner = producer({ cacheOwnership: "exclusive" });
      const current = await owner.prepare();
      for (const name of ["keep-me.txt", "not-a-hash.tgz", ".staging"]) {
        await fs.writeFile(path.join(cacheDir, name), "operator-owned");
      }
      const before = (await fs.readdir(cacheDir)).toSorted();
      const readRetained = vi.fn(() => []);

      await owner.prune(readRetained);

      expect(readRetained).not.toHaveBeenCalled();
      expect((await fs.readdir(cacheDir)).toSorted()).toEqual(before);
      await expect(fs.stat(current.tarballPath)).resolves.toBeDefined();
    });
  });

  it.each([false, true])(
    "retains a persisted provisioning bundle until its environment terminates (empty=%s)",
    async (empty) => {
      await withFixture(async ({ root, packageRoot, producer }) => {
        const databasePath = path.join(root, "state", "openclaw.sqlite");
        const admitted = await producer().prepare();
        const admittedBytes = await fs.readFile(admitted.tarballPath);
        const project = { key: "project", root, baseCommit: "a".repeat(40) };
        const preparation = createWorkerPreparationIdentity({
          namespace: "bundle-retention-test",
          providerId: "fixture",
          profileId: "test",
          profileSnapshot: { settings: {} },
          project: empty ? undefined : project,
          target: { machineClass: "small", platform: "linux" },
          artifacts: {
            nodeBootstrapSha256: "b".repeat(64),
            enabledPluginIds: [],
            workerBundleHash: admitted.bundleHash,
            workerArchiveSha256: admitted.tarballSha256,
            openclawVersion: admitted.openclawVersion,
            protocolFeatures: [...admitted.protocolFeatures],
          },
        });
        try {
          const store = await createWorkerEnvironmentStore({
            database: stateDb.openOpenClawStateDatabase({ path: databasePath }),
          });
          await store.createIntent({
            environmentId: "preparing",
            providerId: "fixture",
            profileId: "test",
            provisionOperationId: "prepare-project",
            profileSnapshot: {
              settings: {},
              ...(empty
                ? { runtimePreparation: { source: "empty", ...preparation } }
                : { project: { ...project, preparation } }),
            },
          });
          await store.transition({
            environmentId: "preparing",
            from: "requested",
            to: "provisioning",
          });
          await stateDb.closeOpenClawStateDatabaseAsync();
          stateDb.closeOpenClawStateDatabaseForTest();

          await writeFixture(packageRoot, "export const value = 2;\n");
          const successor = producer({ cacheOwnership: "exclusive" });
          const current = await successor.prepare();
          expect(current.bundleHash).not.toBe(admitted.bundleHash);
          const reopened = await createWorkerEnvironmentStore({
            database: stateDb.openOpenClawStateDatabase({ path: databasePath }),
          });
          expect(reopened.get("preparing")).toMatchObject({
            state: "provisioning",
            bootstrapReceipt: null,
          });
          const retained = () =>
            listRetainedWorkerBundleHashes({ environments: reopened.list(), placements: [] });

          await successor.prune(retained);
          await expect(fs.readFile(admitted.tarballPath)).resolves.toEqual(admittedBytes);

          await reopened.transition({
            environmentId: "preparing",
            from: "provisioning",
            to: "failed",
          });
          await successor.prune(retained);
          await expect(fs.stat(admitted.tarballPath)).rejects.toMatchObject({ code: "ENOENT" });
          await expect(fs.stat(current.tarballPath)).resolves.toBeDefined();
        } finally {
          await stateDb.closeOpenClawStateDatabaseAsync();
          stateDb.closeOpenClawStateDatabaseForTest();
        }
      }, "export const value = 1;\n");
    },
  );

  it("reclaims recognized crash artifacts but preserves unknown cache entries", async () => {
    await withFixture(async ({ cacheDir, producer }) => {
      const owner = producer({ cacheOwnership: "exclusive" });
      const current = await owner.prepare();
      const staging = path.join(cacheDir, ".staging-stale");
      const temporary = path.join(
        cacheDir,
        `${"b".repeat(64)}.tgz.123.123e4567-e89b-12d3-a456-426614174000.tmp`,
      );
      const unknown = path.join(cacheDir, "keep-me.txt");
      await fs.mkdir(staging);
      await fs.writeFile(temporary, "partial");
      await fs.writeFile(unknown, "operator-owned");

      await owner.prune(() => []);

      await expect(fs.stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(unknown, "utf8")).resolves.toBe("operator-owned");
      await expect(fs.stat(current.tarballPath)).resolves.toBeDefined();
    });
  });

  it.each(["all", "staging", "temporary"] as const)(
    "preserves cleanup candidates when retention cannot be read (%s)",
    async (kind) => {
      await withTestDir({ prefix: "openclaw-worker-bundle-retention-error-" }, async (root) => {
        const packageRoot = path.join(root, "package");
        const cacheDir = path.join(root, "cache");
        await writeFixture(packageRoot);
        const owner = createWorkerBundleProducer({
          packageRoot,
          cacheDir,
          cacheOwnership: "exclusive",
        });
        const current = await owner.prepare();
        const historical = path.join(cacheDir, `${"b".repeat(64)}.tgz`);
        const staging = path.join(cacheDir, ".staging-stale");
        const temporary = path.join(
          cacheDir,
          `${current.bundleHash}.tgz.123.123e4567-e89b-12d3-a456-426614174000.tmp`,
        );
        const candidates =
          kind === "all"
            ? [historical, staging, temporary]
            : [kind === "staging" ? staging : temporary];
        if (candidates.includes(historical)) {
          await fs.writeFile(historical, "historical");
        }
        if (candidates.includes(staging)) {
          await fs.mkdir(staging);
          await fs.writeFile(path.join(staging, "partial"), "staged");
        }
        if (candidates.includes(temporary)) {
          await fs.writeFile(temporary, "partial");
        }
        const failure = new Error("Retention records are unavailable");

        await expect(
          owner.prune(() => {
            throw failure;
          }),
        ).rejects.toBe(failure);

        for (const candidate of candidates) {
          const file = candidate === staging ? path.join(staging, "partial") : candidate;
          const contents =
            candidate === historical ? "historical" : candidate === staging ? "staged" : "partial";
          await expect(fs.readFile(file, "utf8")).resolves.toBe(contents);
        }
        await expect(fs.stat(current.tarballPath)).resolves.toBeDefined();

        await owner.prune(() => []);
        for (const removed of candidates) {
          await expect(fs.stat(removed)).rejects.toMatchObject({ code: "ENOENT" });
        }
        await expect(fs.stat(current.tarballPath)).resolves.toBeDefined();
      });
    },
  );

  it("reads retention when queued pruning runs", async () => {
    await withFixture(async ({ cacheDir, producer }) => {
      const owner = producer({ cacheOwnership: "exclusive" });
      const current = await owner.prepare();
      const firstHash = "a".repeat(64);
      const secondHash = "b".repeat(64);
      const obsolete = path.join(cacheDir, `${"c".repeat(64)}.tgz`);
      for (const hash of [firstHash, secondHash]) {
        await fs.writeFile(path.join(cacheDir, `${hash}.tgz`), hash);
      }
      await fs.writeFile(obsolete, "obsolete");
      const inspectingObsolete = createDeferred();
      const releaseInspection = createDeferred();
      const originalLstat = fs.lstat;
      const lstat = vi.spyOn(fs, "lstat").mockImplementation(async (target, options) => {
        if (target === obsolete) {
          inspectingObsolete.resolve();
          await releaseInspection.promise;
        }
        return originalLstat(target, options);
      });
      const first = owner.prune(() => [firstHash, secondHash]);
      let second: Promise<void> | undefined;
      let retained = [firstHash];
      const readRetained = vi.fn(() => retained);
      try {
        await inspectingObsolete.promise;
        second = owner.prune(readRetained);
        expect(readRetained).not.toHaveBeenCalled();
        retained = [firstHash, secondHash];
        releaseInspection.resolve();
        await Promise.all([first, second]);

        expect(readRetained).toHaveBeenCalledTimes(1);
        for (const hash of [firstHash, secondHash]) {
          await expect(fs.readFile(path.join(cacheDir, `${hash}.tgz`), "utf8")).resolves.toBe(hash);
        }
        await expect(fs.stat(obsolete)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(current.tarballPath)).resolves.toBeDefined();
      } finally {
        releaseInspection.resolve();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
        lstat.mockRestore();
      }
    });
  });

  it("keeps custom caches non-destructive after failed preparation", async () => {
    await withFixture(async ({ cacheDir, producer }) => {
      await fs.mkdir(cacheDir);
      const historical = path.join(cacheDir, `${"c".repeat(64)}.tgz`);
      await fs.writeFile(historical, "historical");
      const shared = producer();

      await expect(shared.prepare()).rejects.toThrow("worker deploy artifact is missing");
      await shared.prune(() => []);
      await expect(fs.readFile(historical, "utf8")).resolves.toBe("historical");
    }, false);
  });

  it("archives staged bytes when the source changes during packaging", async () => {
    const originalContents = "export const value = 'before';\n";
    await withFixture(async ({ root, packageRoot, producer }) => {
      const baselineRoot = path.join(root, "baseline");
      await writeFixture(baselineRoot, originalContents);
      const baseline = await producer({
        packageRoot: baselineRoot,
        cacheDir: path.join(root, "baseline-cache"),
      }).prepare();
      const originalCollect = bundleStaging.collectWorkerBundleManifest;
      let sourceMutated = false;
      const stagingSpy = vi
        .spyOn(bundleStaging, "collectWorkerBundleManifest")
        .mockImplementation(async (...args) => {
          const manifest = await originalCollect(...args);
          sourceMutated = true;
          await writeWorker(packageRoot, "export const value = 'after';\n");
          return manifest;
        });

      try {
        const artifact = await producer().prepare();
        const extractDir = path.join(root, "extract");
        await fs.mkdir(extractDir);
        await tar.extract({ file: artifact.tarballPath, cwd: extractDir });

        expect(sourceMutated).toBe(true);
        expect(artifact.bundleHash).toBe(baseline.bundleHash);
        await expect(fs.readFile(path.join(extractDir, "worker.mjs"), "utf8")).resolves.toBe(
          originalContents,
        );
      } finally {
        stagingSpy.mockRestore();
      }
    }, originalContents);
  });

  it("owns one immutable build snapshot and retries failed preparation", async () => {
    await withFixture(async ({ packageRoot, producer }) => {
      const owner = producer({ protocolFeatures: ["resume", "admission", "resume"] });
      const failed = owner.prepare();
      await expect(failed).rejects.toThrow("worker deploy artifact is missing");
      await writeFixture(packageRoot);

      const retried = owner.prepare();
      expect(retried).not.toBe(failed);
      const first = await retried;
      await writeWorker(packageRoot, "changed\n");
      await expect(owner.prepare()).resolves.toBe(first);
      expect(first.protocolFeatures).toEqual(["admission", "resume"]);
    }, false);
  });

  it("replaces a corrupt content-addressed cache entry", async () => {
    await withFixture(async ({ producer }) => {
      const first = await producer().prepare();
      await fs.writeFile(first.tarballPath, "not a tarball");

      const repaired = await producer().prepare();

      expect(repaired.bundleHash).toBe(first.bundleHash);
      await expect(listTarball(repaired.tarballPath)).resolves.toEqual(artifactNames);
    });
  });

  it.skipIf(process.platform === "win32")("rejects symlinked deploy artifacts", async () => {
    for (const artifactName of ["worker-chunk-symlink.mjs", ...artifactNames].filter(
      (name) => !["code-mode-node.worker.mjs", "windows-security-helper.exe"].includes(name),
    )) {
      await withFixture(async ({ packageRoot, cacheDir, producer }) => {
        const artifactPath = path.join(packageRoot, "dist", "worker", artifactName);
        if (artifactName === "worker-chunk-symlink.mjs") {
          await fs.writeFile(artifactPath, "export {};\n");
        }
        await fs.rename(artifactPath, `${artifactPath}.target`);
        await fs.symlink(`${artifactName}.target`, artifactPath);
        await expect(producer().prepare()).rejects.toThrow("Unsafe worker deploy artifact");
        // Sibling artifacts stage concurrently; their writes must settle before staging cleanup.
        await expect(fs.readdir(cacheDir)).resolves.toEqual([]);
      });
    }
  });
});

describe("worker npm installation artifact", () => {
  it("uses an exact registry-proven gateway package", async () => {
    await withTestDir({ prefix: "openclaw-worker-npm-" }, async (packageRoot) => {
      const packageIntegrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
      const verifyRelease = vi.fn(async () => packageIntegrity);

      const artifact = await resolveWorkerNpmInstallationArtifact({
        bundle: bundleArtifact({ protocolFeatures: ["admission"] }),
        packageRoot,
        verifyRelease,
      });

      expect(verifyRelease).toHaveBeenCalledWith({
        bundleHash: "a".repeat(64),
        version: "1.2.3",
      });
      expect(artifact).toEqual({
        install: "npm",
        bundleHash: "a".repeat(64),
        openclawVersion: "1.2.3",
        packageIntegrity,
        protocolFeatures: ["admission"],
        packageSpec: "openclaw@1.2.3",
      });
    });
  });

  it.each([
    ["dev", "exact published gateway version"],
    ["unpublished", "use the worker bundle install"],
    ["source", "packaged release install"],
  ] as const)("rejects a %s npm installation", async (kind, error) => {
    await withTestDir({ prefix: "openclaw-worker-npm-" }, async (packageRoot) => {
      if (kind === "source") {
        await fs.mkdir(path.join(packageRoot, ".git"));
      }
      const verifyRelease = vi.fn(async () => {
        if (kind === "source") {
          return `sha512-${Buffer.alloc(64).toString("base64")}`;
        }
        throw new Error("OpenClaw 1.2.3 is not published; use the worker bundle install");
      });
      await expect(
        resolveWorkerNpmInstallationArtifact({
          bundle: bundleArtifact({ openclawVersion: kind === "dev" ? "dev" : "1.2.3" }),
          packageRoot,
          verifyRelease,
        }),
      ).rejects.toThrow(error);
      expect(verifyRelease).toHaveBeenCalledTimes(kind === "unpublished" ? 1 : 0);
    });
  });
});
