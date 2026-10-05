import { openSync, closeSync } from "node:fs";

export async function run(
  argv: string[],
  options: {
    cwd?: string;
    log?: string;
    signal?: AbortSignal;
    input?: string;
    raw?: boolean;
  } = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  const descriptor = options.log
    ? openSync(options.log, "a", 0o600)
    : undefined;
  try {
    const child = Bun.spawn(argv, {
      cwd: options.cwd,
      stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
      stdout: descriptor ?? "pipe",
      stderr: descriptor ?? "pipe",
    });
    const stop = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", stop, { once: true });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 45 * 60_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        typeof child.stdout === "number" ? "" : readOutput(child.stdout),
        typeof child.stderr === "number" ? "" : readOutput(child.stderr),
      ]);
      options.signal?.throwIfAborted();
      if (code !== 0)
        throw new Error(
          `${argv[0]} exited ${code}${options.log ? "; see deployment logs" : `: ${stderr.slice(-1500)}`}`,
        );
      return options.raw ? stdout : stdout.trimEnd();
    } catch (error) {
      child.kill("SIGKILL");
      await child.exited;
      throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", stop);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function readOutput(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 20_000_000) {
        await reader.cancel();
        throw new Error("Command output exceeds 20 MB");
      }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}
