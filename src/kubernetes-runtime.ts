import { randomBytes } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { appendFile } from "node:fs/promises";
import { run } from "./process";
import type {
  DeploymentRuntime,
  RuntimeContext,
  ImageBuild,
  StartServices,
  ImporterTask,
  Service,
} from "./runtime";
import {
  configurationResource,
  importerJob,
  namespaceResource,
  serviceDeployment,
  serviceResources,
  workspacePath,
  workspaceResources,
  type KubernetesStorage,
} from "./kubernetes-resources";

export type KubernetesOptions = KubernetesStorage & {
  context: string;
  imageRepository: string;
  buildkitAddress: string;
};

/** Kubernetes execution with a separately managed BuildKit service for images.
 * The MCP process needs kubectl, buildctl, tar and credentials for both services.
 * It never opens a Docker socket or selects the user's implicit kube context.
 */
export class KubernetesRuntime implements DeploymentRuntime {
  readonly kind = "kubernetes" as const;
  private readonly forwards = new Map<
    string,
    { port: number; process: ReturnType<typeof Bun.spawn> }
  >();
  constructor(
    readonly options: KubernetesOptions,
    private readonly execute = run,
  ) {
    if (
      !options.context ||
      !options.imageRepository ||
      !options.buildkitAddress
    )
      throw new Error(
        "Kubernetes context, image repository and BuildKit address are required",
      );
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9.\-:/]*$/.test(options.imageRepository) ||
      options.imageRepository.endsWith("/")
    )
      throw new Error("Invalid image repository");
  }
  private command(context: RuntimeContext, args: string[]) {
    return [
      "kubectl",
      "--context",
      this.options.context,
      "--namespace",
      namespaceResource(context).metadata.name,
      ...args,
    ];
  }
  private async kube(
    context: RuntimeContext,
    args: string[],
    signal?: AbortSignal,
    input?: string,
  ) {
    return this.execute(this.command(context, args), { signal, input });
  }
  private async apply(
    context: RuntimeContext,
    items: unknown[],
    signal?: AbortSignal,
  ) {
    await this.kube(
      context,
      ["apply", "-f", "-"],
      signal,
      JSON.stringify({ apiVersion: "v1", kind: "List", items }),
    );
  }
  private async ensureNamespace(context: RuntimeContext, create = true) {
    const manifest = namespaceResource(context);
    const existing = await this.kube(context, [
      "get",
      "namespace",
      manifest.metadata.name,
      "--ignore-not-found",
      "-o",
      "json",
    ]);
    if (!existing) {
      if (!create) return false;
      await this.kube(
        context,
        ["create", "-f", "-"],
        undefined,
        JSON.stringify(manifest),
      );
      return true;
    }
    if (
      JSON.parse(existing).metadata?.labels?.[
        "app.kubernetes.io/managed-by"
      ] !== "cbio-deployment-mcp"
    )
      throw new Error("Refusing to use a namespace not owned by this MCP");
    return true;
  }
  private image(logical: string) {
    const match = /^(cbio-mcp-[a-f0-9]{12}):([A-Za-z0-9_.-]+)$/.exec(logical);
    if (!match) throw new Error("Invalid deployment image name");
    return `${this.options.imageRepository}:${match[1]}-${match[2]}`;
  }
  private async ready(
    context: RuntimeContext,
    name: string,
    signal?: AbortSignal,
  ) {
    await this.kube(
      context,
      ["rollout", "status", `deployment/${name}`, "--timeout=600s"],
      signal,
    );
  }
  private async workspacePod(context: RuntimeContext, signal?: AbortSignal) {
    const name = await this.kube(
      context,
      [
        "get",
        "pods",
        "-l",
        "app.kubernetes.io/name=workspace",
        "--field-selector=status.phase=Running",
        "-o",
        "jsonpath={.items[0].metadata.name}",
      ],
      signal,
    );
    if (!/^[a-z0-9-]+$/.test(name))
      throw new Error("Workspace pod is unavailable");
    return name;
  }
  private async upload(
    context: RuntimeContext,
    local: string,
    signal?: AbortSignal,
  ) {
    const path = workspacePath(context, local);
    const pod = await this.workspacePod(context, signal);
    const destination = `/workspace/${dirname(path)}`;
    await this.kube(
      context,
      ["exec", pod, "--", "mkdir", "-p", destination],
      signal,
    );
    await this.kube(
      context,
      ["cp", local, `${pod}:${destination}`, "-c", "workspace"],
      signal,
    );
  }
  async prepare(context: RuntimeContext) {
    await this.ensureNamespace(context);
    await this.apply(context, workspaceResources(context, this.options));
    await this.ready(context, "workspace");
    await this.upload(context, join(context.directory, "runtime"));
    await this.apply(context, [
      configurationResource(context),
      ...serviceResources(context),
    ]);
  }
  async build(
    context: RuntimeContext,
    build: ImageBuild,
    signal?: AbortSignal,
  ) {
    const dockerfile = build.dockerfile ?? join(build.source, "Dockerfile");
    await this.execute(
      [
        "buildctl",
        "--addr",
        this.options.buildkitAddress,
        "build",
        "--frontend",
        "dockerfile.v0",
        "--local",
        `context=${build.source}`,
        "--local",
        `dockerfile=${dirname(dockerfile)}`,
        "--opt",
        `filename=${basename(dockerfile)}`,
        "--output",
        `type=image,name=${this.image(build.image)},push=true`,
      ],
      { signal, log: join(context.directory, "operations.log") },
    );
  }
  async up(
    context: RuntimeContext,
    options: StartServices,
    signal?: AbortSignal,
  ) {
    const services: Service[] = options.service
      ? [options.service]
      : ["database", "mongo", "session", "app"];
    await this.disconnect(context.state.id);
    for (const service of services) {
      await this.apply(
        context,
        [
          serviceDeployment(
            context,
            this.options,
            service,
            this.image(context.state.image),
          ),
        ],
        signal,
      );
      if (options.recreate)
        await this.kube(
          context,
          ["rollout", "restart", `deployment/${service}`],
          signal,
        );
      await this.ready(context, service, signal);
    }
    await this.connect(context, signal);
  }
  async stopApp(context: RuntimeContext, signal?: AbortSignal) {
    await this.kube(
      context,
      ["scale", "deployment/app", "--replicas=0"],
      signal,
    );
    await this.kube(
      context,
      [
        "wait",
        "--for=delete",
        "pod",
        "-l",
        "app.kubernetes.io/name=app",
        "--timeout=180s",
      ],
      signal,
    );
    await this.disconnect(context.state.id);
  }
  async restartApp(context: RuntimeContext, signal?: AbortSignal) {
    await this.kube(context, ["rollout", "restart", "deployment/app"], signal);
    await this.ready(context, "app", signal);
    await this.disconnect(context.state.id);
    await this.connect(context, signal);
  }
  async execDatabase(
    context: RuntimeContext,
    argv: string[],
    signal?: AbortSignal,
  ) {
    const output = await this.kube(
      context,
      ["exec", "deployment/database", "--", ...argv],
      signal,
    );
    await appendFile(join(context.directory, "operations.log"), output + "\n", {
      mode: 0o600,
    });
  }
  async runImporter(
    context: RuntimeContext,
    task: ImporterTask,
    signal?: AbortSignal,
  ) {
    await this.upload(context, join(context.directory, "runtime"), signal);
    if (task.study) await this.upload(context, task.study, signal);
    if (task.reference) await this.upload(context, task.reference, signal);
    const name = `task-${randomBytes(6).toString("hex")}`;
    let primaryError: unknown;
    try {
      await this.apply(
        context,
        [
          importerJob(
            context,
            this.options,
            task,
            this.image(task.image),
            name,
          ),
        ],
        signal,
      );
      const deadline = Date.now() + 46 * 60_000;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const job = JSON.parse(
          await this.kube(context, ["get", "job", name, "-o", "json"], signal),
        );
        const conditions = job.status?.conditions ?? [];
        if (
          conditions.some(
            (c: { type: string; status: string }) =>
              c.type === "Complete" && c.status === "True",
          )
        )
          return;
        if (
          conditions.some(
            (c: { type: string; status: string }) =>
              c.type === "Failed" && c.status === "True",
          )
        )
          throw new Error("Importer Job failed; inspect deployment logs");
        await Bun.sleep(1000);
      }
      throw new Error("Importer Job exceeded its deadline");
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const errors: unknown[] = [];
      try {
        const output = await this.kube(context, [
          "logs",
          `job/${name}`,
          "--all-containers=true",
          "--tail=2000",
        ]);
        await appendFile(
          join(context.directory, "operations.log"),
          output + "\n",
          { mode: 0o600 },
        );
      } catch (error) {
        errors.push(error);
      }
      try {
        // No canceled signal: wait for pods before removing their snapshots.
        await this.kube(context, [
          "delete",
          "job",
          name,
          "--ignore-not-found",
          "--cascade=foreground",
          "--wait=true",
          "--timeout=180s",
        ]);
        const pod = await this.workspacePod(context);
        for (const local of [task.study, task.reference]) {
          if (local)
            await this.kube(context, [
              "exec",
              pod,
              "--",
              "rm",
              "-rf",
              "--",
              `/workspace/${workspacePath(context, local)}`,
            ]);
        }
      } catch (error) {
        errors.push(error);
      }
      if (errors.length)
        throw new AggregateError(
          primaryError ? [primaryError, ...errors] : errors,
          primaryError instanceof Error
            ? `${primaryError.message}; importer cleanup or log collection also failed`
            : "Importer cleanup or log collection failed",
        );
    }
  }

  async logs(context: RuntimeContext, service: Service, lines: number) {
    return this.kube(context, [
      "logs",
      `deployment/${service}`,
      `--tail=${lines}`,
      "--all-containers=true",
    ]);
  }
  async destroy(
    context: RuntimeContext,
    deleteData: boolean,
    signal?: AbortSignal,
  ) {
    if (!(await this.ensureNamespace(context, false))) return;
    await this.disconnect(context.state.id);
    if (deleteData) {
      await this.kube(
        context,
        [
          "delete",
          "namespace",
          context.state.id,
          "--wait=true",
          "--timeout=180s",
        ],
        signal,
      );
    } else {
      await this.kube(
        context,
        [
          "delete",
          "deployment,service,job",
          "-l",
          "app.kubernetes.io/managed-by=cbio-deployment-mcp",
          "--ignore-not-found",
          "--cascade=foreground",
          "--wait=true",
          "--timeout=180s",
        ],
        signal,
      );
    }
  }
  async restore(context: RuntimeContext) {
    if (context.state.phase === "ready") await this.connect(context);
  }
  async close() {
    for (const id of [...this.forwards.keys()]) await this.disconnect(id);
  }
  private async disconnect(id: string) {
    const forward = this.forwards.get(id);
    if (!forward) return;
    this.forwards.delete(id);
    forward.process.kill();
    await forward.process.exited;
  }
  private async connect(context: RuntimeContext, signal?: AbortSignal) {
    const current = this.forwards.get(context.state.id);
    if (
      current?.port === context.state.port &&
      current.process.exitCode === null
    )
      return;
    await this.disconnect(context.state.id);
    signal?.throwIfAborted();
    const child = Bun.spawn(
      this.command(context, [
        "port-forward",
        "--address=127.0.0.1",
        "service/app",
        `${context.state.port}:8080`,
      ]),
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    this.forwards.set(context.state.id, {
      port: context.state.port,
      process: child,
    });
    // Drain bounded diagnostics so a long-lived tunnel cannot block on its pipe.
    let diagnostics = "";
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream)
        diagnostics = (diagnostics + new TextDecoder().decode(chunk)).slice(
          -4000,
        );
    };
    void Promise.all([drain(child.stdout), drain(child.stderr)]).catch(
      () => {},
    );
    try {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        if (child.exitCode !== null)
          throw new Error(`Port forward exited: ${diagnostics}`);
        if (diagnostics.includes("Forwarding from 127.0.0.1:")) return;
        await Bun.sleep(100);
      }
      throw new Error("Port forward did not become ready");
    } catch (error) {
      await this.disconnect(context.state.id);
      throw error;
    }
  }
}
