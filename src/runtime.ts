import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { Deployment } from "./deployments";
import { compose } from "./compose";
import { run } from "./process";

export type RuntimeContext = { state: Deployment; directory: string };
export type ImageBuild = { image: string; source: string; dockerfile?: string };
export type StartServices = { service?: "app"; recreate?: boolean };
export type ImporterTask = {
  image: string;
  operation: "import" | "delete";
  script: string;
  args: string[];
  study?: string;
  reference?: string;
  importGenePanels?: boolean;
};
export type Service = "app" | "database" | "session" | "mongo";

/** Lifecycle operations needed by the MCP, independent of a container engine.
 * Importer tasks must finish (or fail) before resolving, and must be cleaned up
 * even on cancellation. destroy(false) must retain database/session data.
 */
export interface DeploymentRuntime {
  prepare(context: RuntimeContext): Promise<void>;
  build(
    context: RuntimeContext,
    build: ImageBuild,
    signal?: AbortSignal,
  ): Promise<void>;
  up(
    context: RuntimeContext,
    options: StartServices,
    signal?: AbortSignal,
  ): Promise<void>;
  stopApp(context: RuntimeContext, signal?: AbortSignal): Promise<void>;
  restartApp(context: RuntimeContext, signal?: AbortSignal): Promise<void>;
  execDatabase(
    context: RuntimeContext,
    argv: string[],
    signal?: AbortSignal,
  ): Promise<void>;
  runImporter(
    context: RuntimeContext,
    task: ImporterTask,
    signal?: AbortSignal,
  ): Promise<void>;
  logs(
    context: RuntimeContext,
    service: Service,
    lines: number,
  ): Promise<string>;
  destroy(
    context: RuntimeContext,
    deleteData: boolean,
    signal?: AbortSignal,
  ): Promise<void>;
}

/** Compatibility backend, retained until Kubernetes passes workflow acceptance. */
export class DockerRuntime implements DeploymentRuntime {
  constructor(private readonly execute = run) {}

  async prepare({ state, directory }: RuntimeContext) {
    await writeFile(
      join(directory, "compose.json"),
      JSON.stringify(compose(state, directory), null, 2),
      { mode: 0o600 },
    );
  }

  private command(args: string[]) {
    const host = process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock";
    if (!host.startsWith("unix://"))
      throw new Error("Only local Unix-socket Docker is supported");
    return ["docker", "--host", host, ...args];
  }

  private async docker(
    context: RuntimeContext,
    args: string[],
    signal?: AbortSignal,
  ) {
    await this.execute(this.command(args), {
      log: join(context.directory, "operations.log"),
      signal,
    });
  }

  private composeArgs({ state, directory }: RuntimeContext, args: string[]) {
    return [
      "compose",
      "-p",
      state.id,
      "-f",
      join(directory, "compose.json"),
      ...args,
    ];
  }

  private async compose(
    context: RuntimeContext,
    args: string[],
    signal?: AbortSignal,
  ) {
    await this.docker(context, this.composeArgs(context, args), signal);
  }

  async build(
    context: RuntimeContext,
    build: ImageBuild,
    signal?: AbortSignal,
  ) {
    await this.docker(
      context,
      [
        "build",
        "-t",
        build.image,
        ...(build.dockerfile ? ["-f", build.dockerfile] : []),
        build.source,
      ],
      signal,
    );
  }

  async up(
    context: RuntimeContext,
    options: StartServices,
    signal?: AbortSignal,
  ) {
    await this.compose(
      context,
      [
        "up",
        "-d",
        ...(options.recreate ? ["--force-recreate"] : []),
        ...(options.service ? [options.service] : []),
      ],
      signal,
    );
  }

  async stopApp(context: RuntimeContext, signal?: AbortSignal) {
    await this.compose(context, ["stop", "app"], signal);
  }

  async restartApp(context: RuntimeContext, signal?: AbortSignal) {
    await this.compose(context, ["restart", "app"], signal);
  }

  async execDatabase(
    context: RuntimeContext,
    argv: string[],
    signal?: AbortSignal,
  ) {
    await this.compose(context, ["exec", "-T", "database", ...argv], signal);
  }

  async runImporter(
    context: RuntimeContext,
    task: ImporterTask,
    signal?: AbortSignal,
  ) {
    const name = `${context.state.id}-${task.operation}`;
    const runtime = join(context.directory, "runtime");
    try {
      await this.docker(
        context,
        [
          "run",
          "--name",
          name,
          "--memory",
          "4g",
          "--network",
          `${context.state.id}_default`,
          ...(task.study ? ["-v", `${task.study}:/study`] : []),
          "-v",
          `${runtime}:/runtime:ro`,
          ...(task.reference ? ["-v", `${task.reference}:/reference:ro`] : []),
          ...(task.importGenePanels !== undefined
            ? ["-e", `IMPORT_GENE_PANELS=${task.importGenePanels ? "1" : "0"}`]
            : []),
          "-e",
          "PORTAL_HOME=/runtime",
          "-e",
          "PYTHONUNBUFFERED=1",
          "--entrypoint",
          "sh",
          task.image,
          task.script,
          ...task.args,
        ],
        signal,
      );
    } finally {
      // Cleanup deliberately does not inherit an aborted operation signal.
      const existing = await this.execute(
        this.command(["ps", "-aq", "--filter", `name=^${name}$`]),
      );
      if (existing) await this.docker(context, ["rm", "-f", name]);
    }
  }

  async logs(context: RuntimeContext, service: Service, lines: number) {
    return this.execute(
      this.command(
        this.composeArgs(context, [
          "logs",
          "--no-color",
          "--tail",
          String(lines),
          service,
        ]),
      ),
    );
  }

  async destroy(
    context: RuntimeContext,
    deleteData: boolean,
    signal?: AbortSignal,
  ) {
    if (await Bun.file(join(context.directory, "compose.json")).exists()) {
      await this.compose(
        context,
        ["down", ...(deleteData ? ["-v"] : [])],
        signal,
      );
    }
  }
}
