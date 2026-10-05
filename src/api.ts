import { z } from "zod/v4";

export const apiSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    path: z
      .string()
      .min(6)
      .max(2048)
      .refine(
        (path) => path.startsWith("/api/") && !/[\\?#]/.test(path),
        "Use /api/...; supply query parameters separately",
      ),
    query: z.record(z.string(), z.string()).default({}),
    body: z.json().optional(),
    timeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
    maxResponseBytes: z
      .number()
      .int()
      .min(1024)
      .max(1_000_000)
      .default(100_000),
  })
  .strict()
  .refine(
    (input) => input.method !== "GET" || input.body === undefined,
    "GET requests cannot contain a body",
  );

export async function apiRequest(
  port: number,
  input: z.input<typeof apiSchema>,
  signal?: AbortSignal,
) {
  const parsed = apiSchema.parse(input);
  const url = new URL(parsed.path, `http://127.0.0.1:${port}`);
  if (!url.pathname.startsWith("/api/"))
    throw new Error("Path must stay under /api/");
  for (const [key, value] of Object.entries(parsed.query))
    url.searchParams.set(key, value);
  const body =
    parsed.body === undefined ? undefined : JSON.stringify(parsed.body);
  if (body && Buffer.byteLength(body) > 1_000_000)
    throw new Error("JSON body exceeds 1 MB");
  const response = await fetch(url, {
    method: parsed.method,
    body,
    headers: body
      ? { "Content-Type": "application/json", Accept: "application/json" }
      : { Accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.any([
      AbortSignal.timeout(parsed.timeoutMs),
      ...(signal ? [signal] : []),
    ]),
  });
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  if (reader) {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const remaining = parsed.maxResponseBytes - bytes;
        chunks.push(next.value.subarray(0, remaining));
        bytes += Math.min(remaining, next.value.length);
        if (next.value.length > remaining) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let data: unknown = text;
  if (!truncated && response.headers.get("content-type")?.includes("json")) {
    try {
      data = JSON.parse(text);
    } catch {
      /* Preserve malformed JSON as text for diagnosis. */
    }
  }
  return {
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get("content-type"),
    truncated,
    body: data,
  };
}
