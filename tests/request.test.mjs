import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildRequest,
  executeRequest,
  serializeForOutput,
} from "../skills/google-maps-data/scripts/gmapscraper-request.mjs";

const root = new URL("../", import.meta.url);
const skill = new URL("../skills/google-maps-data/", import.meta.url);
const testKey = `gms_${"test"}_${"ABC123"}_${"x".repeat(32)}`;
const environment = { GMSCRAPER_API_KEY: testKey };

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("fallback builds a bounded authenticated create request without putting the key in the URL", async () => {
  const request = await buildRequest({
    operation: "places.search",
    input: { q: "coffee shops in Seattle", page: 1, hl: "en", gl: "us", extra: false },
    client_request_id: "gmaps-test-request-0001",
    wait_seconds: 10,
  }, environment);
  assert.equal(request.url.href, "https://gmapscrawl.com/api/v1/scrapes");
  assert.equal(request.url.href.includes(testKey), false);
  assert.equal(request.init.headers.get("api-key"), testKey);
  assert.equal(request.init.headers.get("idempotency-key"), "gmaps-test-request-0001");
  assert.equal(request.init.headers.get("prefer"), "wait=10");
  assert.deepEqual(JSON.parse(request.init.body), {
    operation: "places.search",
    input: { q: "coffee shops in Seattle", page: 1, hl: "en", gl: "us", extra: false },
  });
  assert.equal(request.init.redirect, "error");
});

test("fallback maps canonical read, export, and cancellation routes exactly", async () => {
  const results = await buildRequest({
    operation: "jobs.results",
    input: { job_id: "scr_12345678", cursor: "opaque-cursor", limit: 50 },
  }, environment);
  assert.equal(
    results.url.href,
    "https://gmapscrawl.com/api/v1/scrapes/scr_12345678/results?cursor=opaque-cursor&limit=50",
  );
  assert.equal(results.init.method, "GET");
  assert.equal(results.init.body, undefined);

  const exported = await buildRequest({
    operation: "exports.create",
    input: { job_id: "scr_12345678", format: "ndjson" },
    client_request_id: "gmaps-test-export-0001",
  }, environment);
  assert.equal(
    exported.url.href,
    "https://gmapscrawl.com/api/v1/scrapes/scr_12345678/exports",
  );
  assert.deepEqual(JSON.parse(exported.init.body), { format: "ndjson" });

  const canceled = await buildRequest({
    operation: "jobs.cancel",
    input: { job_id: "scr_12345678" },
    client_request_id: "gmaps-test-cancel-0001",
  }, environment);
  assert.equal(
    canceled.url.href,
    "https://gmapscrawl.com/api/v1/scrapes/scr_12345678/cancel",
  );
  assert.equal(canceled.init.body, undefined);
});

test("fallback emits a machine-readable fixture response and redacts a reflected key", async () => {
  let calls = 0;
  const result = await executeRequest({
    operation: "places.search",
    input: { q: "fixture cafe", page: 1 },
    client_request_id: "gmaps-test-request-0002",
  }, environment, async () => {
    calls += 1;
    return new Response(JSON.stringify({
      data: {
        id: "scr_1fixture000000000000000000000000",
        operation: "places.search",
        status: "succeeded",
        simulated: true,
      },
      reflected: testKey,
    }), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-request-id": "req_fixture",
        "x-gms-schema-version": "2026-09-01",
      },
    });
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.response.data.simulated, true);
  const output = serializeForOutput(result, testKey);
  assert.doesNotMatch(output, new RegExp(testKey));
  assert.match(output, /\[REDACTED\]/);
  assert.deepEqual(JSON.parse(output).operation, "places.search");
});

test("fallback rejects unsafe or ambiguous requests before network access", async () => {
  let called = false;
  const fetcher = async () => {
    called = true;
    throw new Error("must not run");
  };
  await assert.rejects(
    executeRequest({ operation: "places.search", input: { q: "fixture" } }, environment, fetcher),
    (error) => error.code === "invalid_client_request_id",
  );
  await assert.rejects(
    executeRequest({
      operation: "place.reviews",
      input: { fid: "fixture", page: 1, unexpected: true },
      client_request_id: "gmaps-test-request-0003",
    }, environment, fetcher),
    (error) => error.code === "invalid_document",
  );
  await assert.rejects(
    executeRequest({ operation: "unknown", input: {} }, environment, fetcher),
    (error) => error.code === "unsupported_operation",
  );
  assert.equal(called, false);
});

test("fallback enforces the one MiB response ceiling", async () => {
  await assert.rejects(
    executeRequest({
      operation: "jobs.get",
      input: { job_id: "scr_12345678" },
    }, environment, async () => new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(1024 * 1024 + 1),
      },
    })),
    (error) => error.code === "response_too_large",
  );
});

test("skill package contains no credential-shaped example and routes MCP first", async () => {
  const [instructions, metadata, operations] = await Promise.all([
    readFile(new URL("SKILL.md", skill), "utf8"),
    readFile(new URL("agents/openai.yaml", skill), "utf8"),
    readFile(new URL("references/operations.json", skill), "utf8"),
  ]);
  assert.match(instructions, /Prefer the configured remote MCP server/);
  assert.match(instructions, /GMSCRAPER_API_KEY/);
  assert.doesNotMatch(`${instructions}\n${metadata}\n${operations}`, /gms_(?:live|test)_[A-Za-z0-9_-]{6,24}_[A-Za-z0-9_-]{32,128}/);
  assert.match(metadata, /\$google-maps-data/);
});
