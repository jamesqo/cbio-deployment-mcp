import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deployments, deploySchema, type Deployment } from "../src/deployments";
import {
  KubernetesRuntime,
  type KubernetesOptions,
} from "../src/kubernetes-runtime";
import { configuredRuntime } from "../src/runtime-config";
import {
  configurationResource,
  importerJob,
  serviceDeployment,
  serviceResources,
  workspacePath,
  workspaceResources,
} from "../src/kubernetes-resources";
import type { RuntimeContext } from "../src/runtime";

const options: KubernetesOptions = {
  context: "explicit-dev-context",
  imageRepository: "registry.example/engineer",
  buildkitAddress: "unix:///run/buildkit/buildkitd.sock",
  workspaceClass: "shared-workspace",
  databaseClass: "block-storage",
};
function context(directory = "/private/cbio-mcp-abcdef123456"): RuntimeContext {
  const state: Deployment = {
    ...deploySchema.parse({ cbioportal: { kind: "local", path: "/source" } }),
    id: "cbio-mcp-abcdef123456",
    runtime: "kubernetes",
    password: "private-password",
    image: "cbio-mcp-abcdef123456:1",
    generation: 1,
    resolved: [],
    coreResolved: [],
    phase: "ready",
    operation: "deploy",
    updatedAt: "now",
  };
  return { directory, state };
}

test("Kubernetes portal workloads use private services, secrets and persistent volumes without host Docker access", () => {
  // GIVEN the same portal configuration used by the deployment workflow.
  const ctx = context();
  const names = ["app", "database", "mongo", "session"] as const;

  // WHEN rendering every long-running service and its storage.
  const workloads = names.map((name) =>
    serviceDeployment(ctx, options, name, "registry.example/engineer:app"),
  );
  const storage = workspaceResources(ctx, options).filter(
    (item) => item.kind === "PersistentVolumeClaim",
  );
  const secret = configurationResource(ctx);

  // THEN storage outlives pods and credentials are absent from workload specs.
  expect(storage.map((item) => item.metadata.name)).toEqual([
    "workspace",
    "database",
    "sessions",
  ]);
  expect(JSON.stringify(workloads)).not.toContain(ctx.state.password);
  expect(secret.stringData["application.properties"]).toContain(
    "jdbc:ch://database:8123/cbioportal",
  );
  expect(secret.stringData.password).toBe(ctx.state.password);
  for (const workload of workloads) {
    expect(workload.metadata.namespace).toBe(ctx.state.id);
    expect(workload.spec.strategy.type).toBe("Recreate");
    expect(workload.spec.template.spec.automountServiceAccountToken).toBe(
      false,
    );
  }
  const manifests = JSON.stringify([
    ...workloads,
    ...workspaceResources(ctx, options),
  ]);
  expect(manifests).not.toContain('"hostPath"');
  expect(manifests).not.toContain("docker.sock");
  expect(
    serviceResources(ctx).every((item) => item.spec.type === "ClusterIP"),
  ).toBe(true);
});

test("import jobs preserve command arguments, use writable study snapshots, and do not retry partial imports", () => {
  // GIVEN an import with gene panels and warning override.
  const ctx = context();

  // WHEN rendering a job on the shared workspace.
  const job = importerJob(
    ctx,
    options,
    {
      image: ctx.state.image,
      operation: "import",
      script: "/runtime/import.sh",
      args: ["-o"],
      study: join(ctx.directory, "imports-1/0"),
      reference: join(ctx.directory, "imports-1/reference"),
      importGenePanels: true,
    },
    "registry.example/engineer:importer",
    "task-abcdef123456",
  );
  const container = job.spec.template.spec.containers[0] as {
    command: string[];
    volumeMounts: {
      name: string;
      mountPath: string;
      subPath: string;
      readOnly?: boolean;
    }[];
  };

  // THEN mutations are not automatically replayed and originals are not mounted.
  expect(job.spec.backoffLimit).toBe(0);
  expect(job.spec.template.spec.restartPolicy).toBe("Never");
  expect(job.spec.activeDeadlineSeconds).toBe(2700);
  expect(container.command).toEqual(["sh", "/runtime/import.sh", "-o"]);
  expect(container.volumeMounts.find((m) => m.mountPath === "/study")).toEqual({
    name: "workspace",
    mountPath: "/study",
    subPath: "imports-1/0",
  });
  expect(
    container.volumeMounts.find((m) => m.mountPath === "/reference")?.readOnly,
  ).toBe(true);
  expect(() => workspacePath(ctx, "/private/unrelated-study")).toThrow(
    "inside their deployment",
  );
  expect(() => workspacePath(ctx, ctx.directory)).toThrow(
    "inside their deployment",
  );
});

for (const mode of [
  "success",
  "failed",
  "cancel",
  "failed-and-logs-fail",
] as const) {
  test(`Kubernetes importer ${mode}: reports the result and cleans up only its Job`, async () => {
    // GIVEN a controlled Kubernetes API and a private deployment directory.
    const root = await mkdtemp(join(tmpdir(), "kube-import-"));
    const ctx = context(root);
    const controller = new AbortController();
    const calls: { argv: string[]; signal?: AbortSignal }[] = [];
    let jobName = "";
    const runtime = new KubernetesRuntime(options, async (argv, execution) => {
      calls.push({ argv, signal: execution?.signal });
      if (argv.includes("pods")) return "workspace-abc-123";
      if (argv.includes("apply")) {
        const manifest = JSON.parse(execution!.input!);
        jobName = manifest.items[0].metadata.name;
        if (mode === "cancel") controller.abort();
      }
      if (argv.includes("get") && argv.includes("job"))
        return JSON.stringify({
          status: {
            conditions: [
              {
                type: mode === "success" ? "Complete" : "Failed",
                status: "True",
              },
            ],
          },
        });
      if (argv.includes("logs")) {
        if (mode === "failed-and-logs-fail")
          throw new Error("Log service unavailable");
        return "importer diagnostic";
      }
      return "";
    });
    try {
      // WHEN the importer succeeds, fails, or is canceled after submission.
      const pending = runtime.runImporter(
        ctx,
        {
          image: `${ctx.state.id}:importer-1`,
          operation: "delete",
          script: "/runtime/delete.sh",
          args: ["one,two"],
        },
        controller.signal,
      );
      if (mode === "success") await pending;
      else if (mode === "cancel") await expect(pending).rejects.toThrow();
      else await expect(pending).rejects.toThrow("Importer Job failed");

      // THEN terminal cleanup is awaited without the canceled signal.
      const deletion = calls.find(
        (call) => call.argv.includes("delete") && call.argv.includes("job"),
      );
      expect(deletion?.argv).toContain(jobName);
      expect(deletion?.argv).toContain("--cascade=foreground");
      expect(deletion?.argv).toContain("--wait=true");
      expect(deletion?.signal).toBeUndefined();
      expect(calls.every((call) => call.argv[0] === "kubectl")).toBe(true);
      expect(
        calls.every((call) => call.argv.includes("explicit-dev-context")),
      ).toBe(true);
      if (mode !== "failed-and-logs-fail")
        expect(await readFile(join(root, "operations.log"), "utf8")).toContain(
          "importer diagnostic",
        );
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("Kubernetes builds publish to the configured registry through BuildKit", async () => {
  // GIVEN an explicit builder and image repository.
  const calls: string[][] = [];
  const runtime = new KubernetesRuntime(options, async (argv) => {
    calls.push(argv);
    return "";
  });
  const ctx = context();

  // WHEN building the backend image.
  await runtime.build(ctx, {
    image: ctx.state.image,
    source: "/source",
    dockerfile: "/source/docker/web/Dockerfile",
  });

  // THEN no Docker command is needed and the output is available to cluster nodes.
  expect(calls[0]?.[0]).toBe("buildctl");
  expect(calls[0]).toContain("dockerfile=/source/docker/web");
  expect(calls[0]).toContain(
    "type=image,name=registry.example/engineer:cbio-mcp-abcdef123456-1,push=true",
  );
});

test("destroy refuses an unowned namespace and never creates a missing namespace", async () => {
  // GIVEN an unrelated namespace that happens to have the requested name.
  const mutations: string[][] = [];
  let exists = true;
  const runtime = new KubernetesRuntime(options, async (argv) => {
    if (argv.includes("get"))
      return exists ? JSON.stringify({ metadata: { labels: {} } }) : "";
    mutations.push(argv);
    return "";
  });

  // WHEN deletion is requested for the unrelated namespace or a missing one.
  await expect(runtime.destroy(context(), true)).rejects.toThrow("not owned");
  exists = false;
  await runtime.destroy(context(), true);

  // THEN neither case modifies cluster resources.
  expect(mutations).toEqual([]);
});

test("Kubernetes mode rejects legacy Docker state before connecting to the cluster", async () => {
  // GIVEN a saved deployment from before runtimes were selectable.
  const root = await mkdtemp(join(tmpdir(), "kube-state-"));
  const ctx = context();
  const { runtime: _, ...legacy } = ctx.state;
  const directory = join(root, ctx.state.id);
  await mkdir(directory);
  await writeFile(join(directory, "state.json"), JSON.stringify(legacy));
  const calls: string[][] = [];
  const runtime = new KubernetesRuntime(options, async (argv) => {
    calls.push(argv);
    return "";
  });
  const deployments = new Deployments(root, undefined, runtime);
  try {
    // WHEN starting in Kubernetes mode against the Docker state directory.
    await expect(deployments.initialize()).rejects.toThrow(
      "separate CBIO_MCP_HOME",
    );

    // THEN the saved deployment is untouched and no cluster request was made.
    expect(calls).toEqual([]);
    expect(
      JSON.parse(await readFile(join(directory, "state.json"), "utf8")),
    ).toEqual(legacy);
  } finally {
    await deployments.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime configuration requires an explicit Kubernetes target and rejects unknown modes", () => {
  // GIVEN empty or incomplete runtime settings.
  expect(configuredRuntime({}).kind).toBe("docker");

  // WHEN Kubernetes is requested without a target, or the mode is misspelled.
  // THEN startup fails rather than selecting the user's current cluster.
  expect(() => configuredRuntime({ CBIO_RUNTIME: "kubernetes" })).toThrow(
    "CBIO_KUBE_CONTEXT",
  );
  expect(() => configuredRuntime({ CBIO_RUNTIME: "kubernets" })).toThrow(
    "must be docker or kubernetes",
  );
});
