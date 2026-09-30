#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const MAX_DOCUMENT_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000;
const CONTRACT_URL = new URL("../references/operations.json", import.meta.url);

class RequestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RequestError";
    this.code = code;
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function integerSetting(value, fallback, minimum, maximum, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new RequestError("invalid_environment", `${name} is outside its allowed range.`);
  return parsed;
}

function configuration(environment, canonicalBaseUrl) {
  const apiKey = environment.GMSCRAPER_API_KEY?.trim();
  if (
    !apiKey ||
    !/^gms_(?:live|test)_[A-Za-z0-9_-]{6,24}_[A-Za-z0-9_-]{32,128}$/.test(apiKey)
  )
    throw new RequestError(
      "missing_api_key",
      "Configure GMSCRAPER_API_KEY in the server-side secret environment.",
    );

  let baseUrl;
  try {
    baseUrl = new URL(canonicalBaseUrl);
  } catch {
    throw new RequestError("invalid_contract", "The packaged canonical API URL is invalid.");
  }
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, "");
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.hostname !== "gmapscrawl.com" ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    !baseUrl.pathname.endsWith("/api/v1")
  )
    throw new RequestError(
      "invalid_contract",
      "The packaged canonical API URL failed its origin policy.",
    );

  return {
    apiKey,
    baseUrl,
    timeoutMs: integerSetting(
      environment.GMSCRAPER_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      1_000,
      180_000,
      "GMSCRAPER_TIMEOUT_MS",
    ),
    maximumResponseBytes: integerSetting(
      environment.GMSCRAPER_MAX_RESPONSE_BYTES,
      MAX_RESPONSE_BYTES,
      1_024,
      MAX_RESPONSE_BYTES,
      "GMSCRAPER_MAX_RESPONSE_BYTES",
    ),
  };
}

async function contract() {
  const source = await readFile(CONTRACT_URL, "utf8");
  return JSON.parse(source);
}

function assertRequestDocument(document, operation) {
  if (!plainObject(document))
    throw new RequestError("invalid_document", "The request document must be a JSON object.");
  const allowedTopLevel = new Set([
    "operation",
    "input",
    "client_request_id",
    "wait_seconds",
  ]);
  for (const key of Object.keys(document))
    if (!allowedTopLevel.has(key))
      throw new RequestError("invalid_document", `Unknown request field: ${key}.`);
  if (!plainObject(document.input))
    throw new RequestError("invalid_document", "input must be a JSON object.");

  const allowedInput = new Set(Object.keys(operation.input_schema?.properties ?? {}));
  for (const key of Object.keys(document.input))
    if (!allowedInput.has(key))
      throw new RequestError("invalid_document", `Unknown operation input field: ${key}.`);

  if (operation.requires_client_request_id) {
    if (
      typeof document.client_request_id !== "string" ||
      !/^[\x21-\x7e]{16,128}$/.test(document.client_request_id)
    )
      throw new RequestError(
        "invalid_client_request_id",
        "Mutations require a 16–128 character printable client_request_id without spaces.",
      );
  } else if (document.client_request_id !== undefined) {
    throw new RequestError(
      "invalid_client_request_id",
      "This read-only operation does not accept client_request_id.",
    );
  }

  if (document.wait_seconds !== undefined) {
    if (
      !operation.allows_wait ||
      !Number.isInteger(document.wait_seconds) ||
      document.wait_seconds < 1 ||
      document.wait_seconds > 25
    )
      throw new RequestError(
        "invalid_wait",
        "wait_seconds is available only for scrape creation and must be 1 through 25.",
      );
  }
}

function assertOpaqueId(name, value) {
  const expression = name === "job_id"
    ? /^(?:job|scr)_[A-Za-z0-9_-]{8,80}$/
    : /^exp_[A-Za-z0-9_-]{8,80}$/;
  if (typeof value !== "string" || !expression.test(value))
    throw new RequestError("invalid_document", `${name} is malformed.`);
}

export async function buildRequest(document, environment = process.env) {
  const contractDocument = await contract();
  const operation = contractDocument.operations?.[document?.operation];
  if (!operation)
    throw new RequestError("unsupported_operation", "The operation is not in the canonical registry.");
  assertRequestDocument(document, operation);
  if (Buffer.byteLength(JSON.stringify(document.input), "utf8") > operation.maximum_input_bytes)
    throw new RequestError("request_too_large", "The canonical operation input limit was exceeded.");
  const config = configuration(environment, contractDocument.base_url);
  const input = { ...document.input };
  let path = operation.rest.path;
  for (const parameter of operation.path_parameters) {
    const value = input[parameter];
    assertOpaqueId(parameter, value);
    path = path.replace(`{${parameter}}`, encodeURIComponent(value));
    delete input[parameter];
  }

  const target = new URL(config.baseUrl.toString());
  target.pathname = `${config.baseUrl.pathname}${path}`;
  const headers = new Headers({
    Accept: "application/json",
    "API-KEY": config.apiKey,
  });
  if (operation.requires_client_request_id)
    headers.set("Idempotency-Key", document.client_request_id);
  if (document.wait_seconds !== undefined)
    headers.set("Prefer", `wait=${document.wait_seconds}`);

  let body;
  if (operation.rest.method === "GET") {
    for (const parameter of operation.query_parameters) {
      const value = input[parameter];
      if (value !== undefined) target.searchParams.set(parameter, String(value));
      delete input[parameter];
    }
  } else if (operation.request_shape === "scrape_envelope") {
    body = JSON.stringify({ operation: document.operation, input: document.input });
  } else if (Object.keys(input).length > 0) {
    body = JSON.stringify(input);
  }
  if (Object.keys(input).length > 0 && operation.rest.method === "GET")
    throw new RequestError("invalid_document", "The operation contains unmapped input fields.");
  if (body !== undefined) {
    if (Buffer.byteLength(body, "utf8") > operation.maximum_input_bytes)
      throw new RequestError("request_too_large", "The canonical operation input limit was exceeded.");
    headers.set("Content-Type", "application/json; charset=utf-8");
  }

  return {
    operation: document.operation,
    apiKey: config.apiKey,
    maximumResponseBytes: config.maximumResponseBytes,
    timeoutMs: config.timeoutMs,
    url: target,
    init: {
      method: operation.rest.method,
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(config.timeoutMs),
    },
  };
}

async function boundedResponseJson(response, maximumBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maximumBytes)
    throw new RequestError("response_too_large", "The API response exceeded the byte limit.");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json")
    throw new RequestError("invalid_response", "The API returned an unexpected content type.");
  if (!response.body)
    throw new RequestError("invalid_response", "The API returned an empty response body.");

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RequestError("response_too_large", "The API response exceeded the byte limit.");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(joined);
    return JSON.parse(source);
  } catch {
    throw new RequestError("invalid_response", "The API returned invalid JSON.");
  }
}

export async function executeRequest(
  document,
  environment = process.env,
  fetchImplementation = globalThis.fetch,
) {
  if (typeof fetchImplementation !== "function")
    throw new RequestError("runtime_unavailable", "This Node runtime does not provide fetch.");
  const request = await buildRequest(document, environment);
  let response;
  try {
    response = await fetchImplementation(request.url, request.init);
  } catch {
    throw new RequestError("transport_error", "The bounded API request failed.");
  }
  const payload = await boundedResponseJson(response, request.maximumResponseBytes);
  return {
    ok: response.ok,
    operation: request.operation,
    http_status: response.status,
    request_id: response.headers.get("x-request-id"),
    schema_version: response.headers.get("x-gms-schema-version"),
    retry_after: response.headers.get("retry-after"),
    response: payload,
  };
}

export function serializeForOutput(value, secret = "") {
  const serialized = JSON.stringify(value);
  return secret ? serialized.split(secret).join("[REDACTED]") : serialized;
}

async function readBoundedStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_DOCUMENT_BYTES)
      throw new RequestError("document_too_large", "The request document exceeds 64 KiB.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readDocument(path) {
  if (path === "-") return readBoundedStdin();
  const details = await stat(path).catch(() => null);
  if (!details?.isFile())
    throw new RequestError("invalid_document", "The request document file was not found.");
  if (details.size > MAX_DOCUMENT_BYTES)
    throw new RequestError("document_too_large", "The request document exceeds 64 KiB.");
  return readFile(path, "utf8");
}

async function main() {
  const argument = process.argv[2];
  if (argument === "--help") {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      usage: "node scripts/gmapscraper-request.mjs <request.json|->",
      credential_environment: "GMSCRAPER_API_KEY",
    })}\n`);
    return;
  }
  let secret = "";
  try {
    if (!argument || process.argv.length !== 3)
      throw new RequestError(
        "invalid_arguments",
        "Pass exactly one request JSON file path or - for stdin.",
      );
    const source = await readDocument(argument);
    let document;
    try {
      document = JSON.parse(source);
    } catch {
      throw new RequestError("invalid_document", "The request document is not valid JSON.");
    }
    secret = process.env.GMSCRAPER_API_KEY?.trim() ?? "";
    const result = await executeRequest(document);
    process.stdout.write(`${serializeForOutput(result, secret)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    const payload = {
      ok: false,
      error: {
        code: error instanceof RequestError ? error.code : "request_failed",
        message: error instanceof RequestError
          ? error.message
          : "The request could not be completed.",
      },
    };
    process.stdout.write(`${serializeForOutput(payload, secret)}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) await main();
