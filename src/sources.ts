import { cp, mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join, relative, isAbsolute, dirname } from "node:path";
import { z } from "zod/v4";
import { run } from "./process";

const ref = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_./-]+$/)
  .refine(
    (value) => !value.startsWith("-") && !value.includes(".."),
    "Invalid Git ref",
  );
const revision = z.union([
  z.object({ ref }).strict(),
  z.object({ pr: z.number().int().positive() }).strict(),
]);
const merge = z.array(revision).max(10).default([]);
export const sourceSchema = z.union([
  z
    .object({
      kind: z.literal("github"),
      base: revision.default({ ref: "HEAD" }),
      merge,
    })
    .strict(),
  z
    .object({
      kind: z.literal("local"),
      path: z.string().min(1),
      ref: ref.optional(),
      includeUncommitted: z.boolean().default(false),
      merge,
    })
    .strict(),
]);
export type Source = z.infer<typeof sourceSchema>;
export type Repository = "cbioportal" | "cbioportal-core";

export async function snapshot(
  source: Source,
  repository: Repository,
  destination: string,
  signal?: AbortSignal,
  execute = run,
): Promise<string[]> {
  const git = (args: string[]) =>
    execute(["git", ...args], { cwd: destination, signal });
  const github = `https://github.com/cBioPortal/${repository}.git`;
  const fetch = async (item: z.infer<typeof revision>, remote: string) => {
    await git([
      "fetch",
      remote,
      "pr" in item ? `refs/pull/${item.pr}/head` : item.ref,
    ]);
    return git(["rev-parse", "FETCH_HEAD"]);
  };
  const fuse = async (
    base: string,
    select: (item: z.infer<typeof revision>) => Promise<string>,
  ) => {
    const resolved = [base];
    await git(["config", "user.name", "cBioPortal local deployment"]);
    await git(["config", "user.email", "local-deployment@localhost"]);
    for (const item of source.merge) {
      const sha = await select(item);
      resolved.push(sha);
      try {
        await git(["merge", "--no-edit", sha]);
      } catch (error) {
        const conflicts = await git(["diff", "--name-only", "--diff-filter=U"]);
        if (conflicts)
          throw new Error(
            `Merge conflicts applying ${"pr" in item ? `PR #${item.pr}` : item.ref}: ${conflicts.split("\n").join(", ")}. Scratch checkout: ${destination}`,
            { cause: error },
          );
        throw error;
      }
    }
    return resolved;
  };
  await mkdir(destination, { recursive: true });
  if (source.kind === "local") {
    const original = resolve(source.path);
    if (source.includeUncommitted && (source.ref || source.merge.length))
      throw new Error(
        "Uncommitted changes require the current checkout; omit ref and merge",
      );
    await execute(
      [
        "git",
        "clone",
        "--no-hardlinks",
        "--no-checkout",
        "--",
        original,
        destination,
      ],
      { signal },
    );
    const selectLocal = (selected: string) =>
      execute(
        [
          "git",
          "-C",
          original,
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${selected}^{commit}`,
        ],
        { signal },
      );
    const selected = await selectLocal(source.ref ?? "HEAD");
    await git(["checkout", "--detach", selected]);
    const resolved = await fuse(selected, async (item) => {
      if ("pr" in item) return fetch(item, github);
      const sha = await selectLocal(item.ref);
      await git(["fetch", "origin", sha]);
      return sha;
    });
    if (source.includeUncommitted) {
      const patch = await execute(
        ["git", "-C", original, "diff", "--binary", "HEAD"],
        { signal, raw: true },
      );
      if (patch)
        await execute(["git", "apply", "--binary", "-"], {
          cwd: destination,
          signal,
          input: patch,
        });
      const files = await execute(
        [
          "git",
          "-C",
          original,
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
        ],
        { signal, raw: true },
      );
      for (const file of files.split("\0").filter(Boolean)) {
        const target = resolve(destination, file);
        if (
          isAbsolute(relative(destination, target)) ||
          relative(destination, target).startsWith("..")
        )
          throw new Error("Unsafe local file path");
        await mkdir(dirname(target), { recursive: true });
        await cp(join(original, file), target, {
          recursive: true,
          dereference: true,
        });
      }
    }
    return resolved;
  }
  await git(["init"]);
  await git(["remote", "add", "origin", github]);
  const base = await fetch(source.base, "origin");
  await git(["checkout", "--detach", base]);
  return fuse(base, (item) => fetch(item, "origin"));
}

export async function prepareBackend(directory: string) {
  let existing = "";
  try {
    existing = await readFile(join(directory, ".dockerignore"), "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  // The git-commit-id Maven plugin requires .git inside the build context.
  await writeFile(
    join(directory, ".dockerignore"),
    `${existing}\ntarget\nnode_modules\n!.git\n!.git/**\n`,
  );
}
