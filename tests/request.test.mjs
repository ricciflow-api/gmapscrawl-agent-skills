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
  }, environment);
  assert.equal(request.url.href, "https://gmapscrawl.com/api/v1/search");
  assert.equal(request.url.href.includes(testKey), false);
  assert.equal(request.init.headers.get("api-key"), testKey);
  assert.equal(request.init.headers.get("idempotency-key"), "gmaps-test-request-0001");
  assert.equal(request.init.headers.get("prefer"), null);
  assert.deepEqual(JSON.parse(request.init.body), { q: "coffee shops in Seattle", page: 1, hl: "en", gl: "us", extra: false });
  assert.equal(request.init.redirect, "error");
});

test("fallback rejects retired operations and asynchronous options before network access", async () => {
  for (const operation of ["jobs.results", "exports.create", "jobs.cancel", "place.reviews", "place.photos"]) {
    await assert.rejects(buildRequest({ operation, input: {}, client_request_id: "gmaps-test-request-0001" }, environment), error => error.code === "unsupported_operation");
  }
  await assert.rejects(buildRequest({ operation: "places.search", input: { q: "fixture" }, client_request_id: "gmaps-test-request-0001", wait_seconds: 10 }, environment), error => error.code === "invalid_wait");
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
      operation: "places.search",
      input: { q: "fixture", page: 1, unexpected: true },
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
      operation: "places.search",
      input: { q: "fixture" },
      client_request_id: "gmaps-test-request-0009",
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

test("packaged skill files match the canonical publication manifest", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", skill), "utf8"));
  for (const [path, expected] of Object.entries(manifest.files)) {
    assert.equal(sha256(await readFile(new URL(path, skill))), expected, path);
  }
  assert.equal(manifest.checksum_algorithm, "sha256");
});
