import {
  mkdir,
  readdir,
  cp,
  writeFile,
  readFile,
  rm,
  chmod,
  rename,
  open,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { z } from "zod/v4";
import { run } from "./process";
import { DockerRuntime, type DeploymentRuntime } from "./runtime";
import { apiRequest, apiSchema } from "./api";
import { sourceSchema, snapshot, prepareBackend } from "./sources";
import { properties, initScript, importScript, deleteScript } from "./compose";

const idSchema = z.string().regex(/^cbio-mcp-[a-f0-9]{12}$/);
export const propertySchema = z
  .record(z.string().regex(/^[a-zA-Z0-9_.-]+$/), z.string().max(4096))
  .refine(
    (values) =>
      Object.keys(values).every(
        (key) =>
          !/password|secret|token|credential/i.test(key) &&
          !/^(spring\.datasource|clickhouse|authenticate|spring\.profiles|session\.service)/.test(
            key,
          ),
      ),
    "Database, authentication and credentials are managed internally",
  );
export const deploySchema = z
  .object({
    cbioportal: sourceSchema,
    core: sourceSchema.optional(),
    port: z.number().int().min(1024).max(65535).default(18080),
    database: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,62}$/)
      .default("cbioportal"),
    properties: propertySchema.default({}),
  })
  .strict();
const stateSchema = deploySchema.extend({
  runtime: z.enum(["docker", "kubernetes"]).default("docker"),
  id: idSchema,
  password: z.string(),
  image: z.string(),
  importerImage: z.string().optional(),
  generation: z.number().int(),
  backendSnapshot: z
    .string()
    .regex(/^backend-[a-f0-9]{12}$/)
    .optional(),
  resolved: z.array(z.string()),
  coreResolved: z.array(z.string()).default([]),
  progress: z
    .object({
      completed: z.number().int(),
      total: z.number().int(),
      stage: z.string(),
      currentStudy: z.string().optional(),
    })
    .optional(),
  phase: z.enum([
    "building",
    "starting",
    "ready",
    "importing",
    "deleting",
    "restarting",
    "stopped",
    "failed",
  ]),
  operation: z.string(),
  error: z.string().optional(),
  updatedAt: z.string(),
});
export type Deployment = z.infer<typeof stateSchema>;
export const identifierSchema = z.object({ id: idSchema }).strict();
export const importSchema = identifierSchema.extend({
  studies: z.array(z.string().min(1)).min(1).max(20),
  genePanels: z.array(z.string().min(1)).max(100).default([]),
  overrideWarnings: z.boolean().default(false),
});

export const deleteSchema = identifierSchema.extend({
  studyIds: z
    .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/))
    .min(1)
    .max(20)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Study IDs must be unique",
    ),
});
const studiesSchema = z.array(z.object({ studyId: z.string() }));

export class Deployments {
  private readonly states = new Map<string, Deployment>();
  private readonly tasks = new Map<
    string,
    { promise: Promise<void>; controller: AbortController }
  >();
  constructor(
    readonly root = resolve(
      process.env.CBIO_MCP_HOME ??
        join(homedir(), ".local/share/cbio-deployment-mcp"),
    ),
    execute = run,
    private readonly runtime: DeploymentRuntime = new DockerRuntime(execute),
  ) {}

  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    for (const id of await readdir(this.root)) {
      if (!idSchema.safeParse(id).success) continue;
      const state = stateSchema.parse(
        JSON.parse(await readFile(join(this.root, id, "state.json"), "utf8")),
      );
      if (state.id !== id)
        throw new Error("Deployment manifest ID does not match directory");
      if (!["ready", "stopped", "failed"].includes(state.phase)) {
        state.phase = "failed";
        state.error =
          "MCP exited during an operation; inspect logs before redeploying";
      }
      if (state.runtime !== (this.runtime.kind ?? "docker"))
        throw new Error(
          "Deployment runtime differs from saved state; use a separate CBIO_MCP_HOME",
        );
      this.states.set(id, state);
    }
    try {
      for (const state of this.states.values())
        await this.runtime.restore?.(this.context(state));
    } catch (error) {
      await this.runtime.close?.();
      throw error;
    }
  }

  list() {
    return Array.from(this.states.values(), (state) => this.view(state));
  }
  status(id: string) {
    return this.view(this.get(id));
  }
  private view(state: Deployment) {
    const { password: _password, ...visible } = state;
    return {
      ...visible,
      url: `http://localhost:${state.port}`,
      busy: this.tasks.has(state.id),
    };
  }
  private get(id: string) {
    idSchema.parse(id);
    const state = this.states.get(id);
    if (!state) throw new Error("Unknown deployment");
    return state;
  }
  private directory(id: string) {
    return join(this.root, id);
  }
  private async save(state: Deployment) {
    state.updatedAt = new Date().toISOString();
    const directory = this.directory(state.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const pending = join(directory, "state.json.tmp");
    await writeFile(pending, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(pending, join(directory, "state.json"));
  }
  private async files(state: Deployment) {
    const directory = this.directory(state.id);
    await writeFile(
      join(directory, "runtime/application.properties"),
      properties(state),
      { mode: 0o600 },
    );
    await this.runtime.prepare(this.context(state));
    await this.save(state);
  }
  private context(state: Deployment) {
    return { state, directory: this.directory(state.id) };
  }
  private start(
    state: Deployment,
    operation: string,
    task: (signal: AbortSignal) => Promise<void>,
  ) {
    if (this.tasks.has(state.id))
      throw new Error("Deployment has an operation in progress");
    state.operation = operation;
    delete state.error;
    delete state.progress;
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => task(controller.signal))
      .catch(async (error: unknown) => {
        state.phase = "failed";
        state.error =
          error instanceof Error ? error.message : "Operation failed";
        await this.save(state);
      })
      .finally(() => this.tasks.delete(state.id));
    this.tasks.set(state.id, { promise, controller });
    // Save errors must also have an explicit rejection owner.
    promise.catch((error) =>
      console.error(
        "Could not persist operation failure:",
        error instanceof Error ? error.message : "Unknown error",
      ),
    );
    return this.view(state);
  }
  async deploy(input: z.input<typeof deploySchema>) {
    const parsed = deploySchema.parse(input);
    if (
      Array.from(this.states.values()).some(
        (state) => state.port === parsed.port && state.phase !== "stopped",
      )
    )
      throw new Error("Port already belongs to a deployment");
    await availablePort(parsed.port);
    if (
      Array.from(this.states.values()).some(
        (state) => state.port === parsed.port && state.phase !== "stopped",
      )
    )
      throw new Error("Port already belongs to a deployment");
    const id = `cbio-mcp-${randomBytes(6).toString("hex")}`;
    const state: Deployment = {
      ...parsed,
      runtime: this.runtime.kind ?? "docker",
      id,
      password: randomBytes(24).toString("hex"),
      image: `${id}:1`,
      generation: 1,
      resolved: [],
      coreResolved: [],
      phase: "building",
      operation: "deploy",
      updatedAt: new Date().toISOString(),
    };
    this.states.set(id, state);
    await this.save(state);
    return this.start(state, "deploy", (signal) =>
      this.buildAndStart(state, true, signal),
    );
  }
  private async buildAndStart(
    state: Deployment,
    refresh: boolean,
    signal: AbortSignal,
  ) {
    const directory = this.directory(state.id);
    const previous = { image: state.image, generation: state.generation };
    const generation = state.resolved.length
      ? state.generation + 1
      : state.generation;
    const snapshotName =
      refresh || !state.backendSnapshot
        ? `backend-${randomBytes(6).toString("hex")}`
        : state.backendSnapshot;
    const backend = join(directory, snapshotName);
    state.phase = "building";
    await this.save(state);
    let resolved = state.resolved;
    if (refresh || !state.backendSnapshot) {
      resolved = await snapshot(
        state.cbioportal,
        "cbioportal",
        backend,
        signal,
      );
      await prepareBackend(backend);
    }
    const image = `${state.id}:${generation}`;
    await this.runtime.build(
      this.context(state),
      {
        image,
        source: backend,
        dockerfile: join(backend, "docker/web/Dockerfile"),
      },
      signal,
    );
    // Leave the running deployment unchanged until the replacement build succeeds.
    state.image = image;
    const runtime = join(directory, "runtime");
    await mkdir(runtime, { recursive: true });
    const sql = join(backend, "src/main/resources/db-scripts/clickhouse");
    for (const [from, to] of [
      ["init/schema.sql", "schema.sql"],
      ["init/seed-cbioportal_hg19_hg38_v2.14.5.sql.gz", "seed.sql.gz"],
      ["populate_derived_tables.sql", "derived.sql"],
    ]) {
      if (from && to) await cp(join(sql, from), join(runtime, to));
    }
    await writeFile(join(runtime, "init.sh"), initScript, { mode: 0o755 });
    await this.files(state);
    state.phase = "starting";
    await this.save(state);
    try {
      await this.runtime.up(this.context(state), {}, signal);
      await this.waitReady(state, signal);
      state.generation = generation;
      state.backendSnapshot = snapshotName;
      state.resolved = resolved;
      state.phase = "ready";
      if (refresh) {
        delete state.importerImage;
        state.coreResolved = [];
      }
      await this.save(state);
    } catch (error) {
      state.image = previous.image;
      state.generation = previous.generation;
      await this.files(state);
      if (state.resolved.length)
        await this.runtime.up(this.context(state), { service: "app" }, signal);
      throw error;
    }
  }
  private async waitReady(state: Deployment, signal: AbortSignal) {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      try {
        const response = await fetch(
          `http://127.0.0.1:${state.port}/api/studies`,
          { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) },
        );
        if (response.ok && Array.isArray(await response.json())) return;
      } catch {
        signal.throwIfAborted();
      }
      await Bun.sleep(1000);
    }
    throw new Error(
      "Backend did not become ready in 180 seconds; inspect logs",
    );
  }
  redeploy(id: string, refreshRefs: boolean) {
    const state = this.get(id);
    return this.start(state, "redeploy", (signal) =>
      this.buildAndStart(state, refreshRefs, signal),
    );
  }
  configure(
    id: string,
    patch: { port?: number; properties?: Record<string, string> },
  ) {
    const state = this.get(id);
    const nextProperties = patch.properties
      ? propertySchema.parse({ ...state.properties, ...patch.properties })
      : state.properties;
    return this.start(state, "configure", async (signal) => {
      const previous = { port: state.port, properties: state.properties };
      if (patch.port !== undefined && patch.port !== state.port) {
        if (
          Array.from(this.states.values()).some(
            (item) =>
              item.id !== id &&
              item.port === patch.port &&
              item.phase !== "stopped",
          )
        )
          throw new Error("Port already belongs to a deployment");
        await availablePort(patch.port);
        if (
          Array.from(this.states.values()).some(
            (item) =>
              item.id !== id &&
              item.port === patch.port &&
              item.phase !== "stopped",
          )
        )
          throw new Error("Port already belongs to a deployment");
        state.port = patch.port;
      }
      state.properties = nextProperties;
      state.phase = "restarting";
      try {
        await this.files(state);
        await this.runtime.up(
          this.context(state),
          { service: "app", recreate: true },
          signal,
        );
        await this.waitReady(state, signal);
        state.phase = "ready";
        await this.save(state);
      } catch (error) {
        state.port = previous.port;
        state.properties = previous.properties;
        await this.files(state);
        await this.runtime.up(this.context(state), {
          service: "app",
          recreate: true,
        });
        throw error;
      }
    });
  }
  restart(id: string) {
    const state = this.get(id);
    return this.start(state, "restart", async (signal) => {
      state.phase = "restarting";
      await this.save(state);
      await this.runtime.restartApp(this.context(state), signal);
      await this.waitReady(state, signal);
      state.phase = "ready";
      await this.save(state);
    });
  }
  private async ensureImporter(state: Deployment, signal: AbortSignal) {
    const directory = this.directory(state.id);
    if (!state.importerImage) {
      const core = join(directory, `core-${randomBytes(6).toString("hex")}`);
      state.coreResolved = await snapshot(
        state.core ?? sourceSchema.parse({ kind: "github" }),
        "cbioportal-core",
        core,
        signal,
      );
      const image = `${state.id}:importer-${state.generation}`;
      await this.runtime.build(
        this.context(state),
        { image, source: core },
        signal,
      );
      state.importerImage = image;
      await this.save(state);
    }
    return state.importerImage;
  }
  private async refreshAfterDataChange(
    state: Deployment,
    count: number,
    signal: AbortSignal,
  ) {
    state.progress = {
      completed: count + 1,
      total: count + 3,
      stage: "Rebuilding derived tables",
    };
    await this.save(state);
    await this.runtime.stopApp(this.context(state), signal);
    await this.runtime.execDatabase(
      this.context(state),
      [
        "sh",
        "-c",
        'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB" --multiquery --param_optimize_backoff_secs=0 < /runtime/derived.sql',
      ],
      signal,
    );
    state.progress = {
      completed: count + 2,
      total: count + 3,
      stage: "Starting backend",
    };
    await this.save(state);
    await this.runtime.up(this.context(state), { service: "app" }, signal);
    await this.waitReady(state, signal);
  }
  async importStudies(input: z.input<typeof importSchema>) {
    const parsed = importSchema.parse(input);
    const state = this.get(parsed.id);
    if (state.phase !== "ready")
      throw new Error("Deployment must be ready before importing studies");
    const paths = parsed.studies.map((path) => resolve(path));
    const genePanels = parsed.genePanels.map((path) => resolve(path));
    for (const path of genePanels) await readFile(path, "utf8");
    for (const path of paths)
      await readFile(join(path, "meta_study.txt"), "utf8");
    return this.start(state, "import_studies", async (signal) => {
      state.phase = "importing";
      state.progress = {
        completed: 0,
        total: paths.length + 3,
        stage: "Building importer",
      };
      await this.save(state);
      const directory = this.directory(state.id);
      const importerImage = await this.ensureImporter(state, signal);
      const runtime = join(directory, "runtime");
      await writeFile(join(runtime, "import.sh"), importScript, {
        mode: 0o644,
      });
      const imports = join(directory, `imports-${Date.now()}`);
      await mkdir(imports);
      try {
        const reference = join(imports, "reference");
        await mkdir(reference);
        for (const [index, path] of genePanels.entries())
          await cp(path, join(reference, `${index}.txt`));
        for (const [index, path] of paths.entries()) {
          const copy = join(imports, String(index));
          await cp(path, copy, { recursive: true, dereference: true });
          state.operation = `import_studies ${index + 1}/${paths.length}`;
          state.progress = {
            completed: index + 1,
            total: paths.length + 3,
            stage: state.operation,
            currentStudy: path,
          };
          await this.save(state);
          // All mounts are snapshots. The importer may write validation output without changing original studies.
          await this.runtime.runImporter(
            this.context(state),
            {
              image: importerImage,
              operation: "import",
              script: "/runtime/import.sh",
              args: parsed.overrideWarnings ? ["-o"] : [],
              study: copy,
              reference,
              importGenePanels: index === 0,
            },
            signal,
          );
        }
        await this.refreshAfterDataChange(state, paths.length, signal);
        state.phase = "ready";
        state.progress = {
          completed: paths.length + 3,
          total: paths.length + 3,
          stage: "Complete",
        };
        state.operation = `Imported ${paths.length} studies`;
        await this.save(state);
      } finally {
        // Restore the backend even if rebuilding derived tables or cancellation failed.
        if (state.phase !== "ready")
          await this.runtime.up(this.context(state), { service: "app" });
        await rm(imports, { recursive: true, force: true });
      }
    });
  }
  async deleteStudies(input: z.input<typeof deleteSchema>) {
    const parsed = deleteSchema.parse(input);
    const state = this.get(parsed.id);
    const before = await this.api(state.id, {
      path: "/api/studies",
      query: { projection: "SUMMARY" },
    });
    if (before.status !== 200)
      throw new Error("Could not list studies before deletion");
    const existingIds = new Set(
      studiesSchema.parse(before.body).map((study) => study.studyId),
    );
    const missing = parsed.studyIds.filter((id) => !existingIds.has(id));
    if (missing.length)
      throw new Error(`Unknown study IDs: ${missing.join(", ")}`);
    return this.start(state, "delete_studies", async (signal) => {
      state.phase = "deleting";
      state.progress = { completed: 0, total: 4, stage: "Preparing importer" };
      await this.save(state);
      const runtime = join(this.directory(state.id), "runtime");
      try {
        const image = await this.ensureImporter(state, signal);
        await writeFile(join(runtime, "delete.sh"), deleteScript);
        await this.runtime.stopApp(this.context(state), signal);
        state.progress = {
          completed: 1,
          total: 4,
          stage: `Deleting ${parsed.studyIds.length} studies`,
        };
        await this.save(state);
        await this.runtime.runImporter(
          this.context(state),
          {
            image,
            operation: "delete",
            script: "/runtime/delete.sh",
            args: [parsed.studyIds.join(",")],
          },
          signal,
        );
        await this.refreshAfterDataChange(state, 1, signal);
        const after = await apiRequest(
          state.port,
          { path: "/api/studies", query: { projection: "SUMMARY" } },
          signal,
        );
        if (after.status !== 200)
          throw new Error("Could not verify study deletion");
        const remaining = new Set(
          studiesSchema.parse(after.body).map((study) => study.studyId),
        );
        const undeleted = parsed.studyIds.filter((id) => remaining.has(id));
        if (undeleted.length)
          throw new Error(
            `Studies still present after deletion: ${undeleted.join(", ")}`,
          );
        state.phase = "ready";
        state.progress = { completed: 4, total: 4, stage: "Complete" };
        state.operation = `Deleted ${parsed.studyIds.length} studies`;
        await this.save(state);
      } finally {
        if (state.phase !== "ready")
          await this.runtime.up(this.context(state), { service: "app" });
      }
    });
  }
  refreshDerivedTables(id: string) {
    const state = this.get(id);
    if (state.phase !== "ready")
      throw new Error(
        "Deployment must be ready before refreshing derived tables",
      );
    return this.start(state, "refresh_derived_tables", async (signal) => {
      state.phase = "restarting";
      state.progress = { completed: 0, total: 3, stage: "Preparing refresh" };
      await this.save(state);
      try {
        await this.refreshAfterDataChange(state, 0, signal);
        state.phase = "ready";
        state.progress = { completed: 3, total: 3, stage: "Complete" };
        state.operation = "Refreshed derived tables";
        await this.save(state);
      } finally {
        if (state.phase !== "ready")
          await this.runtime.up(this.context(state), { service: "app" });
      }
    });
  }
  async logs(
    id: string,
    service?: "app" | "database" | "session" | "mongo",
    lines = 100,
  ) {
    const state = this.get(id);
    let output: string;
    if (service) {
      output = await this.runtime.logs(this.context(state), service, lines);
    } else {
      try {
        const file = await open(
          join(this.directory(id), "operations.log"),
          "r",
        );
        try {
          const size = (await file.stat()).size;
          const buffer = Buffer.alloc(Math.min(size, 128_000));
          const { bytesRead } = await file.read(
            buffer,
            0,
            buffer.length,
            Math.max(0, size - buffer.length),
          );
          output = buffer
            .subarray(0, bytesRead)
            .toString("utf8")
            .split("\n")
            .slice(-lines)
            .join("\n");
        } finally {
          await file.close();
        }
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          output = "";
        else throw error;
      }
    }
    return output.replaceAll(state.password, "[redacted]").slice(-30_000);
  }
  async api(
    id: string,
    input: z.input<typeof apiSchema>,
    signal?: AbortSignal,
  ) {
    const state = this.get(id);
    if (state.phase !== "ready" || this.tasks.has(id))
      throw new Error("Deployment must be ready and idle for API requests");
    await this.runtime.restore?.(this.context(state));
    return apiRequest(state.port, input, signal);
  }
  destroy(id: string, deleteData: boolean) {
    const state = this.get(id);
    return this.start(state, "destroy", async (signal) => {
      await this.runtime.destroy(this.context(state), deleteData, signal);
      state.phase = "stopped";
      await this.save(state);
    });
  }
  cancel(id: string) {
    this.tasks.get(id)?.controller.abort();
  }
  async idle(id: string) {
    await this.tasks.get(id)?.promise;
  }
  async close() {
    for (const task of this.tasks.values()) task.controller.abort();
    await Promise.allSettled(
      Array.from(this.tasks.values(), (task) => task.promise),
    );
    await this.runtime.close?.();
  }
}

async function availablePort(port: number) {
  const listener = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    listener.once("error", reject);
    listener.listen(port, "127.0.0.1", () =>
      listener.close((error) => (error ? reject(error) : resolvePromise())),
    );
  });
}
