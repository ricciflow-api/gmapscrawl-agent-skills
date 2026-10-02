#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, rmdir, writeFile, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://gmapscrawl.com/skills/google-maps-data/";
const FILES = [
  "SKILL.md", "agents/openai.yaml", "references/operations.json",
  "references/operations.md", "references/result-schema.md",
  "scripts/gmapscraper-request.mjs", "scripts/install.mjs",
];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

async function download(path, fetcher) {
  const response = await fetcher(new URL(path, BASE), {
    redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || !response.body) throw new Error(`Download failed: ${path}`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw new Error(`Download exceeded 1 MiB: ${path}`);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

/** Install a complete verified package into a new destination, never overwrite. */
export async function installSkill(destination, fetcher = globalThis.fetch) {
  const target = resolve(destination);
  if (await lstat(target).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  })) throw new Error("Destination already exists; choose a new directory for updates.");
  const bytes = await download("manifest.json", fetcher);
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.skill !== "google-maps-data" || manifest.checksum_algorithm !== "sha256" ||
      !manifest.files || Object.keys(manifest.files).length !== FILES.length ||
      FILES.some(path => !/^[a-f0-9]{64}$/.test(manifest.files[path] ?? ""))) {
    throw new Error("Unexpected skill manifest or package file list.");
  }
  const aggregate = Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b))
    .map(([path, checksum]) => `${path}:${checksum}`).join("\n");
  if (sha256(aggregate) !== manifest.package_sha256) throw new Error("Package checksum mismatch.");

  await mkdir(dirname(target), { recursive: true });
  // Reserve the destination exclusively so concurrent installs cannot overwrite it.
  await mkdir(target);
  let staging;
  try {
    staging = await mkdtemp(join(dirname(target), ".google-maps-data-"));
    for (const path of FILES) {
      const content = await download(path, fetcher);
      if (sha256(content) !== manifest.files[path]) throw new Error(`Checksum mismatch: ${path}`);
      const output = join(staging, path);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, content, { flag: "wx", mode: 0o600 });
    }
    await writeFile(join(staging, "manifest.json"), bytes, { flag: "wx", mode: 0o600 });
    await rename(staging, target);
    return { directory: target, version: manifest.version, package_sha256: manifest.package_sha256 };
  } catch (error) {
    // Only remove the empty directory this invocation reserved.
    await rmdir(target).catch(() => undefined);
    throw error;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2] === "--help") {
      console.log("Usage: node install.mjs <new-skill-directory> (Node.js 24; no API key required)");
      if (process.argv[2] !== "--help") process.exitCode = 1;
    } else console.log(JSON.stringify(await installSkill(process.argv[2])));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
