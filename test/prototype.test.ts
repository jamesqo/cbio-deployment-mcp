import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { run } from "../src/process";
import { snapshot, sourceSchema } from "../src/sources";
import { Deployments, deploySchema, propertySchema } from "../src/deployments";
import { compose, properties } from "../src/compose";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cbio-mcp-test-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function repository() {
  const path = join(directory, "original");
  await mkdir(path);
  const git = (args: string[]) => run(["git", ...args], { cwd: path });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@localhost"]);
  await writeFile(join(path, "tracked"), "original\n");
  await git(["add", "."]);
  await git(["commit", "-m", "initial"]);
  return { path, git };
}

test("local snapshot includes requested dirty and nested untracked files without changing checkout", async () => {
  const { path, git } = await repository();
  await writeFile(join(path, "tracked"), "dirty \n\n");
  await mkdir(join(path, "nested"));
  await writeFile(join(path, "nested/new"), "untracked");
  const before = await git(["status", "--porcelain"]);
  const copy = join(directory, "copy");
  const hashes = await snapshot(
    sourceSchema.parse({ kind: "local", path, includeUncommitted: true }),
    "cbioportal",
    copy,
  );
  expect(hashes).toEqual([await git(["rev-parse", "HEAD"])]);
  expect(await readFile(join(copy, "tracked"), "utf8")).toBe("dirty \n\n");
  expect(await readFile(join(copy, "nested/new"), "utf8")).toBe("untracked");
  expect(await git(["status", "--porcelain"])).toBe(before);
});

test("clean snapshots ignore dirty files and can select a different local branch", async () => {
  const { path, git } = await repository();
  await git(["checkout", "-b", "feature"]);
  await writeFile(join(path, "tracked"), "feature\n");
  await git(["commit", "-am", "feature"]);
  await git(["checkout", "main"]);
  await writeFile(join(path, "tracked"), "dirty \n\n");
  const copy = join(directory, "copy");
  await snapshot(
    sourceSchema.parse({ kind: "local", path, ref: "feature" }),
    "cbioportal",
    copy,
  );
  expect(await readFile(join(copy, "tracked"), "utf8")).toBe("feature\n");
  expect(await git(["branch", "--show-current"])).toBe("main");
  expect(await readFile(join(path, "tracked"), "utf8")).toBe("dirty \n\n");
  await expect(
    snapshot(
      sourceSchema.parse({
        kind: "local",
        path,
        ref: "main",
        includeUncommitted: true,
      }),
      "cbioportal",
      join(directory, "invalid"),
    ),
  ).rejects.toThrow("omit ref");
});

test("Git inputs reject ambiguous selectors and option injection", () => {
  expect(
    sourceSchema.safeParse({ kind: "github", base: { ref: "master", pr: 1 } })
      .success,
  ).toBe(false);
  expect(
    sourceSchema.safeParse({
      kind: "github",
      base: { ref: "--upload-pack=evil" },
    }).success,
  ).toBe(false);
  expect(
    sourceSchema.safeParse({
      kind: "github",
      base: { pr: 183 },
      merge: [{ ref: "feature" }, { pr: 191 }],
    }).success,
  ).toBe(true);
});

test("Compose scopes resources and publishes only the backend on loopback", () => {
  const state = {
    ...deploySchema.parse({
      cbioportal: { kind: "local", path: "/tmp/example" },
      properties: { "skin.title": "Test\nTitle" },
    }),
    id: "cbio-mcp-abcdef123456",
    password: "private",
    image: "image:1",
    generation: 1,
    resolved: [],
    coreResolved: [],
    phase: "ready" as const,
    operation: "deploy",
    updatedAt: "now",
  };
  const config = compose(state, directory);
  expect(config.services.app.ports).toEqual(["127.0.0.1:18080:8080"]);
  expect("ports" in config.services.database).toBe(false);
  expect("container_name" in config.services.app).toBe(false);
  expect(properties(state)).toContain("skin.title=Test\\nTitle");
  expect(
    propertySchema.safeParse({
      "spring.datasource.url": "jdbc:ch://production/db",
    }).success,
  ).toBe(false);
  expect(propertySchema.safeParse({ token: "secret" }).success).toBe(false);
});

test("recovered manifests hide passwords and mark interrupted operations failed", async () => {
  const id = "cbio-mcp-abcdef123456";
  await mkdir(join(directory, id));
  await writeFile(
    join(directory, id, "state.json"),
    JSON.stringify({
      ...deploySchema.parse({ cbioportal: { kind: "local", path: directory } }),
      id,
      password: "private",
      image: "image:1",
      generation: 1,
      resolved: [],
      phase: "importing",
      operation: "import",
      updatedAt: "now",
    }),
  );
  const service = new Deployments(directory);
  await service.initialize();
  expect(service.status(id).phase).toBe("failed");
  expect(JSON.stringify(service.list())).not.toContain("private");
  expect(() => service.status("../../other")).toThrow();
  await expect(
    service.importStudies({ id, studies: [directory] }),
  ).rejects.toThrow("must be ready");
  await service.close();
});

test("deployment rejects occupied ports before creating a build", async () => {
  const listener = createServer();
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  try {
    const address = listener.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP address");
    const service = new Deployments(directory);
    await service.initialize();
    await expect(
      service.deploy({
        cbioportal: { kind: "local", path: directory },
        port: address.port,
      }),
    ).rejects.toThrow();
    expect(service.list()).toEqual([]);
    await service.close();
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("command failure and cancellation reject instead of reporting success", async () => {
  await expect(
    run([process.execPath, "-e", "process.exit(3)"]),
  ).rejects.toThrow("exited 3");
  const controller = new AbortController();
  const pending = run([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toThrow();
});

test("failed replacement build leaves the previous image and Compose configuration intact", async () => {
  const id = "cbio-mcp-abcdef123456";
  const path = join(directory, id);
  await mkdir(join(path, "backend-abcdef123456"), { recursive: true });
  const state = {
    ...deploySchema.parse({ cbioportal: { kind: "local", path: directory } }),
    id,
    password: "private",
    image: `${id}:1`,
    generation: 1,
    backendSnapshot: "backend-abcdef123456",
    resolved: ["a".repeat(40)],
    phase: "ready",
    operation: "deploy",
    updatedAt: "now",
  };
  await writeFile(join(path, "state.json"), JSON.stringify(state));
  await writeFile(join(path, "compose.json"), "original compose");
  const calls: string[][] = [];
  const service = new Deployments(directory, async (argv) => {
    calls.push(argv);
    throw new Error("replacement build failed");
  });
  await service.initialize();
  service.redeploy(id, false);
  expect(() => service.restart(id)).toThrow("in progress");
  await service.idle(id);
  expect(service.status(id).image).toBe(`${id}:1`);
  expect(service.status(id).phase).toBe("failed");
  expect(await readFile(join(path, "compose.json"), "utf8")).toBe(
    "original compose",
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("build");
  await service.close();
});

test("branch and PR combinations use the same ordered merge logic for backend and importer", async () => {
  const { path, git } = await repository();
  await git(["checkout", "-b", "feature"]);
  await writeFile(join(path, "feature"), "branch");
  await git(["add", "."]);
  await git(["commit", "-m", "feature"]);
  const branch = await git(["rev-parse", "HEAD"]);
  await git(["checkout", "main"]);
  await git(["checkout", "-b", "pr"]);
  await writeFile(join(path, "pr"), "pull request");
  await git(["add", "."]);
  await git(["commit", "-m", "pr"]);
  const pr = await git(["rev-parse", "HEAD"]);
  await git(["update-ref", "refs/pull/7/head", pr]);
  const execute: typeof run = (argv, options) =>
    run(
      argv.includes("remote") && argv.includes("add")
        ? [...argv.slice(0, -1), path]
        : argv,
      options,
    );
  for (const repo of ["cbioportal", "cbioportal-core"] as const) {
    const destination = join(directory, repo);
    const hashes = await snapshot(
      sourceSchema.parse({
        kind: "github",
        base: { ref: "main" },
        merge: [{ ref: "feature" }, { pr: 7 }],
      }),
      repo,
      destination,
      undefined,
      execute,
    );
    expect(hashes.slice(1)).toEqual([branch, pr]);
    expect(await readFile(join(destination, "feature"), "utf8")).toBe("branch");
    expect(await readFile(join(destination, "pr"), "utf8")).toBe(
      "pull request",
    );
  }
});

test("merge conflicts report the input and files, preserve scratch checkout, and leave original unchanged", async () => {
  const { path, git } = await repository();
  await git(["checkout", "-b", "first"]);
  await writeFile(join(path, "tracked"), "first\n");
  await git(["commit", "-am", "first"]);
  await git(["checkout", "main"]);
  await git(["checkout", "-b", "second"]);
  await writeFile(join(path, "tracked"), "second\n");
  await git(["commit", "-am", "second"]);
  const before = await git(["rev-parse", "HEAD"]);
  const destination = join(directory, "conflict");
  const execute: typeof run = (argv, options) =>
    run(
      argv.includes("remote") && argv.includes("add")
        ? [...argv.slice(0, -1), path]
        : argv,
      options,
    );
  await expect(
    snapshot(
      sourceSchema.parse({
        kind: "github",
        base: { ref: "first" },
        merge: [{ ref: "second" }],
      }),
      "cbioportal-core",
      destination,
      undefined,
      execute,
    ),
  ).rejects.toThrow("Merge conflicts applying second: tracked");
  expect(
    await run(["git", "diff", "--name-only", "--diff-filter=U"], {
      cwd: destination,
    }),
  ).toBe("tracked");
  expect(await git(["rev-parse", "HEAD"])).toBe(before);
  expect(await git(["status", "--porcelain"])).toBe("");
});

test("cancelling an import removes only its owned importer container and copied study", async () => {
  const id = "cbio-mcp-abcdef123456";
  const path = join(directory, id);
  await mkdir(join(path, "runtime"), { recursive: true });
  const study = join(directory, "study");
  await mkdir(study);
  await writeFile(
    join(study, "meta_study.txt"),
    "cancer_study_identifier: test\n",
  );
  await writeFile(
    join(path, "state.json"),
    JSON.stringify({
      ...deploySchema.parse({ cbioportal: { kind: "local", path: directory } }),
      id,
      password: "private",
      image: "image:1",
      importerImage: "importer:1",
      generation: 1,
      resolved: [],
      phase: "ready",
      operation: "deploy",
      updatedAt: "now",
    }),
  );
  let entered: () => void = () => {};
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const calls: string[][] = [];
  const service = new Deployments(directory, async (argv, options) => {
    calls.push(argv);
    if (argv.includes("run")) {
      const signal = options?.signal;
      if (!signal) throw new Error("Expected abort signal");
      entered();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
      });
    }
    return argv.includes("ps") ? "owned-container-id" : "";
  });
  await service.initialize();
  await service.importStudies({ id, studies: [study] });
  await running;
  await service.close();
  expect(service.status(id).phase).toBe("failed");
  expect(
    calls.some((args) => args.includes("rm") && args.includes(`${id}-import`)),
  ).toBe(true);
  expect(await readFile(join(study, "meta_study.txt"), "utf8")).toBe(
    "cancer_study_identifier: test\n",
  );
  const { readdir } = await import("node:fs/promises");
  expect(
    (await readdir(path)).some((name) => name.startsWith("imports-")),
  ).toBe(false);
});

test("omitted GitHub base follows the remote HEAD rather than assuming a branch name", async () => {
  const { path, git } = await repository();
  const sha = await git(["rev-parse", "HEAD"]);
  const execute: typeof run = (argv, options) =>
    run(
      argv.includes("remote") && argv.includes("add")
        ? [...argv.slice(0, -1), path]
        : argv,
      options,
    );
  const hashes = await snapshot(
    sourceSchema.parse({ kind: "github" }),
    "cbioportal-core",
    join(directory, "default"),
    undefined,
    execute,
  );
  expect(hashes).toEqual([sha]);
});
