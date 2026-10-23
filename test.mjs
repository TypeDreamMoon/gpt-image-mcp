#!/usr/bin/env node
/**
 * End-to-end test with a local mock of the OpenAI image API.
 * No network, no real key, no cost.
 *
 *   node test.mjs
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

let serverChecks = [];

function mockApi() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const isEdit = req.url.endsWith("/images/edits");
      if (!req.url.startsWith("/v1/images/")) {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "nope" } }));
      }
      if (req.headers.authorization !== "Bearer sk-mock") {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "bad key" } }));
      }
      serverChecks.push({
        url: req.url,
        contentType: req.headers["content-type"],
        body: isEdit ? body.slice(0, 120) : JSON.parse(body),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [{ b64_json: TINY_PNG, revised_prompt: "mock revised" }],
          usage: { total_tokens: 42 },
        }),
      );
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function mcpClient(env) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("server.mjs", import.meta.url))], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const pending = new Map();
  const errors = [];
  child.stderr.on("data", (c) => errors.push(c.toString()));
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
      if (!line) continue;
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  return { child, request, errors };
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const mock = await mockApi();
const port = mock.address().port;
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-test-"));
const srcPng = path.join(outDir, "source.png");
fs.writeFileSync(srcPng, Buffer.from(TINY_PNG, "base64"));

// --- protocol + happy path -------------------------------------------------
{
  const { child, request, errors } = mcpClient({
    GPT_IMG_MCP_API_KEY: "sk-mock",
    GPT_IMG_MCP_BASE_URL: `http://127.0.0.1:${port}/v1`,
    GPT_IMG_MCP_MODEL: "gpt-image-test",
    GPT_IMG_MCP_OUTPUT_DIR: outDir,
  });

  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  check("initialize negotiates protocol", init.result?.protocolVersion === "2025-06-18", init.result?.protocolVersion);
  check("server advertises tools", init.result?.capabilities?.tools !== undefined);

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const list = await request("tools/list", {});
  const names = list.result.tools.map((t) => t.name);
  check("tools/list returns generate + edit", names.includes("generate_image") && names.includes("edit_image"), names.join(","));
  check(
    "schemas declare required prompt",
    list.result.tools.every((t) => t.inputSchema.required.includes("prompt")),
  );

  const gen = await request("tools/call", {
    name: "generate_image",
    arguments: { prompt: "a tiny red fox", size: "1024x1024", quality: "high", n: 1 },
  });
  const genText = gen.result?.content?.find((b) => b.type === "text")?.text ?? "";
  const genImage = gen.result?.content?.find((b) => b.type === "image");
  check("generate_image is not an error", gen.result?.isError !== true, genText.split("\n")[0]);
  check("generate_image returns an image block", genImage?.mimeType === "image/png" && genImage.data.length > 0);
  const savedPath = gen.result?.structuredContent?.images?.[0]?.path;
  check("generate_image saved a file", savedPath !== undefined && fs.existsSync(savedPath), savedPath);
  check(
    "usage is reported",
    gen.result?.structuredContent?.usage?.total_tokens === 42,
    JSON.stringify(gen.result?.structuredContent?.usage),
  );

  const sent = serverChecks.find((c) => c.url.endsWith("/images/generations"));
  check(
    "request carries model + params",
    sent?.body?.model === "gpt-image-test" && sent?.body?.size === "1024x1024" && sent?.body?.quality === "high",
    JSON.stringify(sent?.body),
  );
  check("auth header is sent", sent !== undefined);

  const edit = await request("tools/call", {
    name: "edit_image",
    arguments: { prompt: "make it blue", images: [srcPng] },
  });
  check("edit_image succeeds", edit.result?.isError !== true, (edit.result?.content?.[0]?.text ?? "").split("\n")[0]);
  const editReq = serverChecks.find((c) => c.url.endsWith("/images/edits"));
  check("edits use multipart", (editReq?.contentType ?? "").startsWith("multipart/form-data"));
  check("edit result has an image", edit.result?.content?.some((b) => b.type === "image"));

  const multi = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-test-multi-"));
  const both = await request("tools/call", {
    name: "generate_image",
    arguments: { prompt: "two frames", n: 2, output_dir: multi },
  });
  const multiFiles = fs.readdirSync(multi);
  check("output_dir override is honoured", multiFiles.length === 1, `${multi}: ${multiFiles.join(",")}`);

  const bad = await request("tools/call", { name: "nope", arguments: {} });
  check("unknown tool reports isError", bad.result?.isError === true);
  check("stderr is not polluted by protocol", !errors.join("").includes("jsonrpc"));

  child.kill();
}

// --- missing key ----------------------------------------------------------
{
  const { child, request } = mcpClient({
    GPT_IMG_MCP_API_KEY: "",
    OPENAI_API_KEY: "",
    GPT_IMG_MCP_BASE_URL: `http://127.0.0.1:${port}/v1`,
    GPT_IMG_MCP_OUTPUT_DIR: outDir,
  });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const res = await request("tools/call", { name: "generate_image", arguments: { prompt: "x" } });
  const text = res.result?.content?.[0]?.text ?? "";
  check("missing key gives an actionable error", res.result?.isError === true && text.includes("GPT_IMG_MCP_API_KEY"));
  child.kill();
}

// --- provider failure -----------------------------------------------------
{
  const { child, request } = mcpClient({
    GPT_IMG_MCP_API_KEY: "sk-wrong",
    GPT_IMG_MCP_BASE_URL: `http://127.0.0.1:${port}/v1`,
    GPT_IMG_MCP_OUTPUT_DIR: outDir,
  });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const res = await request("tools/call", { name: "generate_image", arguments: { prompt: "x" } });
  const text = res.result?.content?.[0]?.text ?? "";
  check("401 surfaces as isError with status", res.result?.isError === true && text.includes("401"), text);
  child.kill();
}

mock.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
