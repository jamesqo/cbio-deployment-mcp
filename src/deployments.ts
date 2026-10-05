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
import { apiRequest, apiSchema } from "./api";
import { sourceSchema, snapshot, prepareBackend } from "./sources";
import { compose, properties, initScript, importScript } from "./compose";

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
    private readonly execute = run,
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
      this.states.set(id, state);
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
    await writeFile(
      join(directory, "compose.json"),
      JSON.stringify(compose(state, directory), null, 2),
      { mode: 0o600 },
    );
    await this.save(state);
  }
  private async docker(
    args: string[],
    state: Deployment,
    signal?: AbortSignal,
  ) {
    // Only the local Unix socket is supported. Never select a cluster/cloud Docker context.
    if (
      process.env.DOCKER_HOST &&
      !process.env.DOCKER_HOST.startsWith("unix://")
    )
      throw new Error("Only local Unix-socket Docker is supported");
    await this.execute(["docker", "--host", localDockerHost(), ...args], {
      log: join(this.directory(state.id), "operations.log"),
      signal,
    });
  }
  private async compose(
    state: Deployment,
    args: string[],
    signal?: AbortSignal,
  ) {
    await this.docker(
      [
        "compose",
        "-p",
        state.id,
        "-f",
        join(this.directory(state.id), "compose.json"),
        ...args,
      ],
      state,
      signal,
    );
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
    await this.docker(
      [
        "build",
        "-t",
        image,
        "-f",
        join(backend, "docker/web/Dockerfile"),
        backend,
      ],
      state,
      signal,
    );
    // No change to the running Compose project until the replacement build succeeds.
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
      await this.compose(state, ["up", "-d"], signal);
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
        await this.compose(state, ["up", "-d", "app"], signal);
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
        await this.compose(
          state,
          ["up", "-d", "--force-recreate", "app"],
          signal,
        );
        await this.waitReady(state, signal);
        state.phase = "ready";
        await this.save(state);
      } catch (error) {
        state.port = previous.port;
        state.properties = previous.properties;
        await this.files(state);
        await this.compose(state, ["up", "-d", "--force-recreate", "app"]);
        throw error;
      }
    });
  }
  restart(id: string) {
    const state = this.get(id);
    return this.start(state, "restart", async (signal) => {
      state.phase = "restarting";
      await this.save(state);
      await this.compose(state, ["restart", "app"], signal);
      await this.waitReady(state, signal);
      state.phase = "ready";
      await this.save(state);
    });
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
      if (!state.importerImage) {
        const core = join(directory, `core-${randomBytes(6).toString("hex")}`);
        state.coreResolved = await snapshot(
          state.core ?? sourceSchema.parse({ kind: "github" }),
          "cbioportal-core",
          core,
          signal,
        );
        const image = `${state.id}:importer-${state.generation}`;
        await this.docker(["build", "-t", image, core], state, signal);
        state.importerImage = image;
        await this.save(state);
      }
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
          try {
            await this.docker(
              [
                "run",
                "--name",
                `${state.id}-import`,
                "--network",
                `${state.id}_default`,
                "-v",
                `${copy}:/study`,
                "-v",
                `${runtime}:/runtime:ro`,
                "-v",
                `${reference}:/reference:ro`,
                "-e",
                `IMPORT_GENE_PANELS=${index === 0 ? "1" : "0"}`,
                "-e",
                "PORTAL_HOME=/runtime",
                "-e",
                "PYTHONUNBUFFERED=1",
                "--entrypoint",
                "sh",
                state.importerImage,
                "/runtime/import.sh",
                ...(parsed.overrideWarnings ? ["-o"] : []),
              ],
              state,
              signal,
            );
          } finally {
            const existing = await this.execute([
              "docker",
              "--host",
              localDockerHost(),
              "ps",
              "-aq",
              "--filter",
              `name=^${state.id}-import$`,
            ]);
            if (existing)
              await this.docker(["rm", "-f", `${state.id}-import`], state);
          }
        }
        state.progress = {
          completed: paths.length + 1,
          total: paths.length + 3,
          stage: "Rebuilding derived tables",
        };
        await this.save(state);
        await this.compose(state, ["stop", "app"], signal);
        await this.compose(
          state,
          [
            "exec",
            "-T",
            "database",
            "sh",
            "-c",
            'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB" --multiquery --param_optimize_backoff_secs=0 < /runtime/derived.sql',
          ],
          signal,
        );
        state.progress = {
          completed: paths.length + 2,
          total: paths.length + 3,
          stage: "Starting backend",
        };
        await this.save(state);
        await this.compose(state, ["up", "-d", "app"], signal);
        await this.waitReady(state, signal);
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
          await this.compose(state, ["up", "-d", "app"]);
        await rm(imports, { recursive: true, force: true });
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
      output = await this.execute([
        "docker",
        "--host",
        localDockerHost(),
        "compose",
        "-p",
        id,
        "-f",
        join(this.directory(id), "compose.json"),
        "logs",
        "--no-color",
        "--tail",
        String(lines),
        service,
      ]);
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
    return apiRequest(state.port, input, signal);
  }
  destroy(id: string, deleteData: boolean) {
    const state = this.get(id);
    return this.start(state, "destroy", async (signal) => {
      if (await Bun.file(join(this.directory(id), "compose.json")).exists())
        await this.compose(
          state,
          ["down", ...(deleteData ? ["-v"] : [])],
          signal,
        );
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

function localDockerHost() {
  const host = process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock";
  if (!host.startsWith("unix://"))
    throw new Error("Only local Unix-socket Docker is supported");
  return host;
}
