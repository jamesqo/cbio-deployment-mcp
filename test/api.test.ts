import { test, expect } from "bun:test";
import { apiRequest } from "../src/api";

test("API requests encode query parameters, send JSON, and report HTTP failures", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/fail")
        return Response.json({ error: "validation" }, { status: 400 });
      return Response.json({
        path: url.pathname,
        query: url.searchParams.get("q"),
        body: request.method === "POST" ? await request.json() : undefined,
      });
    },
  });
  try {
    const response = await apiRequest(Number(server.url.port), {
      method: "POST",
      path: "/api/studies/fetch",
      query: { q: "a & b" },
      body: ["study"],
    });
    expect(response.body).toEqual({
      path: "/api/studies/fetch",
      query: "a & b",
      body: ["study"],
    });
    const failure = await apiRequest(Number(server.url.port), {
      path: "/api/fail",
    });
    expect(failure.status).toBe(400);
    expect(failure.ok).toBe(false);
    await expect(
      apiRequest(Number(server.url.port), { path: "/api/../admin" }),
    ).rejects.toThrow("under /api");
    await expect(
      apiRequest(Number(server.url.port), { path: "//evil.example/api" }),
    ).rejects.toThrow();
    await expect(
      apiRequest(Number(server.url.port), { path: "/api/studies", body: {} }),
    ).rejects.toThrow("GET requests");
  } finally {
    await server.stop(true);
  }
});

test("API responses are bounded and redirects are returned without following them", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      return new URL(request.url).pathname === "/api/redirect"
        ? Response.redirect("http://example.com")
        : new Response("x".repeat(5000));
    },
  });
  try {
    const response = await apiRequest(Number(server.url.port), {
      path: "/api/large",
      maxResponseBytes: 1024,
    });
    expect(response.truncated).toBe(true);
    expect(response.body).toBe("x".repeat(1024));
    const redirect = await apiRequest(Number(server.url.port), {
      path: "/api/redirect",
    });
    expect(redirect.status).toBe(302);
  } finally {
    await server.stop(true);
  }
});
