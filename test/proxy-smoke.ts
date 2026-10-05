import { strict as assert } from "node:assert";

// Exercise the browser Origin header through a simulated TLS-terminating proxy.
// Kept separate so this regression can also run against an existing deployment.
export async function checkProxyOrigin(backendUrl: string) {
  const endpoint = new URL("/api/studies/tags/fetch", backendUrl);
  for (const [origin, expected] of [
    ["https://phone.example", 200],
    ["https://unrelated.example", 403],
  ] as const) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "phone.example",
        "X-Forwarded-Port": "443",
      },
      body: JSON.stringify(["study_es_0"]),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(
      response.status,
      expected,
      `Origin ${origin}: ${await response.text()}`,
    );
  }
}

if (import.meta.main) {
  await checkProxyOrigin(process.argv[2] ?? "http://127.0.0.1:18884");
  console.log("HTTPS proxy origin accepted; unrelated origin rejected");
}
