import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { z } from "zod";

const baseUrl = process.env.CBIO_ACCEPTANCE_URL ?? "http://127.0.0.1:18885";
const output = resolve(
  process.env.CBIO_ACCEPTANCE_OUTPUT ?? "artifacts/pr-12384",
);
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
});
const page = await context.newPage();
page.setDefaultTimeout(30_000);
const requests: { path: string; status: number }[] = [];
const errors: string[] = [];
const checks: string[] = [];
let source: { gitCommitId: string; portalVersion: string } | undefined;
let passed = false;
page.on("response", (response) => {
  const url = new URL(response.url());
  if (
    url.origin === new URL(baseUrl).origin &&
    url.pathname.startsWith("/api/")
  ) {
    requests.push({
      path: url.pathname + url.search,
      status: response.status(),
    });
  }
});
page.on("pageerror", (error) => errors.push(error.message));
page.on("requestfailed", (request) => {
  errors.push(`${request.url()}: ${request.failure()?.errorText}`);
});
const snapshot = async (name: string) => {
  await page.screenshot({ path: resolve(output, `${name}.png`) });
  await Bun.write(
    resolve(output, `${name}.txt`),
    await page.locator("body").innerText(),
  );
};
const countsSchema = z.array(
  z.object({
    attributeId: z.string(),
    counts: z.array(z.object({ value: z.string(), count: z.number() })),
  }),
);
const binsSchema = z.array(
  z.object({
    count: z.number(),
    specialValue: z.string().nullable().optional(),
  }),
);
try {
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });
  const infoResponse = await page.request.get(
    new URL("/api/info", baseUrl).href,
  );
  assert.equal(infoResponse.status(), 200);
  source = z
    .object({ gitCommitId: z.string(), portalVersion: z.string() })
    .parse(await infoResponse.json());
  if (process.env.CBIO_ACCEPTANCE_COMMIT) {
    assert.equal(source.gitCommitId, process.env.CBIO_ACCEPTANCE_COMMIT);
    checks.push(
      `Running backend matches requested commit ${source.gitCommitId}`,
    );
  }
  const response = await page.request.get(
    new URL(
      "/api/studies/study_es_0/samples?projection=SUMMARY&pageSize=100",
      baseUrl,
    ).href,
  );
  assert.equal(response.status(), 200);
  const samples = z
    .array(z.object({ sampleId: z.string() }))
    .parse(await response.json());
  assert.equal(samples.length, 100);
  await page.goto(new URL("/study/summary?id=study_es_0", baseUrl).href, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  await page
    .getByText("Subtype", { exact: true })
    .first()
    .waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2500);
  await snapshot("study-summary");
  for (const numerical of [false, true]) {
    if (numerical) {
      await page.getByText("Clear All Filters", { exact: true }).click();
      await page
        .getByText(/\b845\s+samples\b/)
        .first()
        .waitFor();
      checks.push("Clearing the custom filter restores all 845 samples");
    }
    await page.getByRole("button", { name: "Charts ▾", exact: true }).click();
    await page.getByText("Custom Data", { exact: true }).click();
    const addAnother = page.getByText("+ Add new custom data", { exact: true });
    if (await addAnother.isVisible()) await addAnother.click();
    if (numerical) await page.getByRole("radio").nth(3).check();
    const title = numerical ? "Acceptance numeric score" : "Acceptance cohort";
    await page
      .getByPlaceholder("Example with newline:", { exact: false })
      .fill(
        samples
          .map(
            ({ sampleId }, i) =>
              `study_es_0:${sampleId}${numerical ? ` ${i + 1}` : ""}`,
          )
          .join("\n"),
      );
    await page.getByPlaceholder("Title (optional)").fill(title);
    const endpoint = numerical
      ? "/api/custom-data-bin-counts/fetch"
      : "/api/custom-data-counts/fetch";
    const [chartResponse] = await Promise.all([
      page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === endpoint &&
          res.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Add Chart", exact: true }).click(),
    ]);
    assert.equal(chartResponse.status(), 200, endpoint);
    const payload: unknown = await chartResponse.json();
    await Bun.write(
      resolve(
        output,
        numerical ? "numeric-response.json" : "cohort-response.json",
      ),
      JSON.stringify(payload, null, 2),
    );
    if (numerical) {
      const bins = binsSchema.parse(payload);
      assert.equal(
        bins
          .filter((bin) => bin.specialValue !== "NA")
          .reduce((sum, bin) => sum + bin.count, 0),
        100,
      );
      assert.equal(
        bins
          .filter((bin) => bin.specialValue === "NA")
          .reduce((sum, bin) => sum + bin.count, 0),
        745,
      );
    } else {
      const counts = countsSchema
        .parse(payload)
        .flatMap((entry) => entry.counts);
      assert.equal(
        counts.find((count) => count.value === "custom_value")?.count,
        100,
      );
      assert.equal(counts.find((count) => count.value === "NA")?.count, 745);
    }
    checks.push(
      `${endpoint}: HTTP 200, 100 entered samples and 745 missing values`,
    );
    await page
      .getByText(/\b100\s+samples\b/)
      .first()
      .waitFor();
    checks.push(`${title} selects the 100 entered samples in Study View`);
    await page.getByRole("button", { name: "Charts ▾", exact: true }).click();
    const chart = page
      .locator(".react-grid-item")
      .filter({ has: page.getByText(title, { exact: true }) });
    await chart.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);
    await snapshot(numerical ? "numeric-chart" : "cohort-chart");
  }
  await page.getByText("Clear All Filters", { exact: true }).click();
  await page
    .getByText(/\b845\s+samples\b/)
    .first()
    .waitFor();
  checks.push("Clearing the numerical filter restores all 845 samples");
  passed = true;
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
  await snapshot("failure");
  throw error;
} finally {
  await Bun.write(
    resolve(output, "report.json"),
    JSON.stringify(
      { passed, url: page.url(), source, checks, requests, errors },
      null,
      2,
    ),
  );
  await context.tracing.stop({ path: resolve(output, "trace.zip") });
  await context.close();
  await browser.close();
  console.log(JSON.stringify({ passed, checks, output }, null, 2));
}
