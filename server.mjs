#!/usr/bin/env node
/**
 * gpt-image MCP server — exposes OpenAI-compatible image generation/editing
 * as MCP tools so any agent harness (pi, Claude Code, Cursor, Codex) can draw.
 *
 * Zero dependencies: MCP over stdio (newline-delimited JSON-RPC) + global fetch.
 * Requires Node >= 18 (tested on 24).
 *
 * Configure with environment variables:
 *   IMAGE_API_KEY     required   API key (fallback: OPENAI_API_KEY)
 *   IMAGE_BASE_URL    optional   default https://api.openai.com/v1
 *   IMAGE_MODEL       optional   default gpt-image-1
 *   IMAGE_OUTPUT_DIR  optional   default ./generated-images
 *   IMAGE_TIMEOUT_MS  optional   default 240000 (image models are slow)
 *   IMAGE_INLINE      optional   "0" returns file paths only, no image blocks
 *   IMAGE_EXTRA_JSON  optional   extra JSON merged into the request body
 *   IMAGE_EDIT_FIELD  optional   multipart field for edits (default: image / image[])
 *
 * Self test:  node server.mjs --check
 */

import fs from "node:fs";
import path from "node:path";

const SERVER_NAME = "gpt-image";
const SERVER_VERSION = "1.0.0";
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const HELP = `gpt-image-mcp ${SERVER_VERSION}

MCP server exposing GPT-image-class image generation and editing to any agent
harness (pi, Claude Code, Cursor, Codex, ...). Runs on stdio; no dependencies.

Usage:  node server.mjs            start the MCP server (stdio)
        node server.mjs --check    print resolved config and probe the endpoint
        node server.mjs --draw P   generate one image and print the saved paths
        node server.mjs --help     this text
        node server.mjs --version  print the version

Environment:
  IMAGE_API_KEY      required   API key (fallback: OPENAI_API_KEY, IMAGE_API_KEY_FILE)
  IMAGE_API_KEY_FILE optional   file containing the key; wins over the vars above
  IMAGE_BASE_URL     optional   default https://api.openai.com/v1
  IMAGE_MODEL        optional   default gpt-image-1
  IMAGE_OUTPUT_DIR   optional   default ./generated-images
  IMAGE_TIMEOUT_MS   optional   default 240000
  IMAGE_INLINE       optional   "0" returns file paths only, no image blocks
  IMAGE_EXTRA_JSON   optional   extra JSON merged into the request body
  IMAGE_EDIT_FIELD   optional   multipart field for edits (default image / image[])
`;

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function readKeyFile() {
  const file = env("IMAGE_API_KEY_FILE");
  if (!file) return undefined;
  try {
    return fs.readFileSync(file.replace(/^~(?=$|[\\/])/, process.env.HOME ?? ""), "utf8").trim();
  } catch {
    return undefined;
  }
}

function config() {
  const apiKey = env("IMAGE_API_KEY") ?? readKeyFile() ?? env("OPENAI_API_KEY");
  return {
    apiKey,
    baseUrl: env("IMAGE_BASE_URL", "https://api.openai.com/v1").replace(/\/+$/, ""),
    model: env("IMAGE_MODEL", "gpt-image-1"),
    outputDir: path.resolve(env("IMAGE_OUTPUT_DIR", path.join(process.cwd(), "generated-images"))),
    timeoutMs: Number(env("IMAGE_TIMEOUT_MS", "240000")) || 240000,
    inline: env("IMAGE_INLINE", "1") !== "0",
    extra: parseExtra(),
    editField: env("IMAGE_EDIT_FIELD"),
  };
}

function parseExtra() {
  const raw = env("IMAGE_EXTRA_JSON");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

class ConfigError extends Error {}

function requireKey(cfg) {
  if (!cfg.apiKey) {
    throw new ConfigError(
      "No image API key configured. Set IMAGE_API_KEY (or OPENAI_API_KEY) to a provider that " +
        "supports POST {base}/images/generations — for example api.openai.com/v1. " +
        "Use `node server.mjs --check` to inspect the resolved config.",
    );
  }
}

// ---------------------------------------------------------------------------
// provider calls
// ---------------------------------------------------------------------------

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function summarize(body, limit = 300) {
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === "string") return message.slice(0, limit);
  } catch {
    /* not JSON */
  }
  return String(body).replace(/\s+/g, " ").trim().slice(0, limit);
}

function apiError(status, body) {
  return new Error(`image API responded ${status}: ${summarize(body, 800)}`);
}

async function postJson(cfg, tool, payload) {
  const res = await fetch(`${cfg.baseUrl}/images/${tool}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw apiError(res.status, text);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`image API returned non-JSON: ${text.slice(0, 200)}`);
  }
}

async function postMultipart(cfg, payload, files, mask) {
  const form = new FormData();
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    form.append(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  const field = cfg.editField ?? (files.length > 1 ? "image[]" : "image");
  for (const file of files) {
    form.append(field, new Blob([file.data], { type: file.mimeType }), file.name);
  }
  if (mask) form.append("mask", new Blob([mask.data], { type: mask.mimeType }), mask.name);

  const res = await fetch(`${cfg.baseUrl}/images/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: "application/json" },
    body: form,
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw apiError(res.status, text);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`image API returned non-JSON: ${text.slice(0, 200)}`);
  }
}

function readInputImage(filePath) {
  const resolved = path.resolve(filePath.replace(/^~(?=$|[\\/])/, process.env.HOME ?? ""));
  let data;
  try {
    data = fs.readFileSync(resolved);
  } catch (error) {
    throw new Error(`cannot read image ${filePath}: ${error.message}`);
  }
  const ext = path.extname(resolved).toLowerCase();
  return {
    data,
    mimeType: MIME_BY_EXT[ext] ?? "application/octet-stream",
    name: path.basename(resolved),
  };
}

// ---------------------------------------------------------------------------
// saving
// ---------------------------------------------------------------------------

function slug(text) {
  const cleaned = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned || "image";
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, `${base}${ext}`);
  for (let i = 2; fs.existsSync(candidate); i += 1) {
    candidate = path.join(dir, `${base}-${i}${ext}`);
  }
  return candidate;
}

async function collectImages(cfg, response) {
  const items = Array.isArray(response?.data) ? response.data : [];
  if (items.length === 0) {
    const hint = response?.error?.message ?? "response contained no image data";
    throw new Error(`image API returned no images: ${hint}`);
  }

  fs.mkdirSync(cfg.outputDir, { recursive: true });
  const saved = [];
  for (const item of items) {
    let buffer;
    let mimeType = "image/png";
    if (item.b64_json) {
      buffer = Buffer.from(item.b64_json, "base64");
    } else if (item.url) {
      const res = await fetch(item.url, { signal: AbortSignal.timeout(cfg.timeoutMs) });
      if (!res.ok) throw apiError(res.status, await res.text());
      buffer = Buffer.from(await res.arrayBuffer());
      mimeType = res.headers.get("content-type")?.split(";")[0] ?? mimeType;
    } else {
      throw new Error("response item has neither b64_json nor url");
    }
    saved.push({ buffer, mimeType, revisedPrompt: item.revised_prompt });
  }
  return saved;
}

function persist(cfg, images, requestedName, prompt) {
  fs.mkdirSync(cfg.outputDir, { recursive: true });
  const base = requestedName ? slug(requestedName) : `${slug(prompt)}-${stamp()}`;
  return images.map((image, index) => {
    const ext = Object.entries(MIME_BY_EXT).find(([, mime]) => mime === image.mimeType)?.[0] ?? ".png";
    const suffix = images.length > 1 ? `-${index + 1}` : "";
    const filePath = uniquePath(cfg.outputDir, `${base}${suffix}`, ext);
    fs.writeFileSync(filePath, image.buffer);
    return { ...image, filePath };
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function resultContent(cfg, files, header, usage) {
  const lines = [header];
  for (const file of files) {
    lines.push(`- ${file.filePath} (${formatSize(file.buffer.length)}, ${file.mimeType})`);
    if (file.revisedPrompt) lines.push(`  revised prompt: ${file.revisedPrompt}`);
  }
  if (usage?.total_tokens !== undefined) lines.push(`tokens: ${JSON.stringify(usage)}`);
  if (!cfg.inline) lines.push("(inline image blocks disabled by IMAGE_INLINE=0)");

  const content = [{ type: "text", text: lines.join("\n") }];
  if (cfg.inline) {
    for (const file of files) {
      content.push({
        type: "image",
        data: file.buffer.toString("base64"),
        mimeType: file.mimeType,
      });
    }
  }
  return {
    content,
    structuredContent: {
      images: files.map((file) => ({
        path: file.filePath,
        mimeType: file.mimeType,
        bytes: file.buffer.length,
        revisedPrompt: file.revisedPrompt,
      })),
      usage: usage ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

const OUTPUT_FORMAT = {
  type: "string",
  enum: ["png", "jpeg", "webp"],
  description: "File format returned by the provider.",
};

const TOOLS = [
  {
    name: "generate_image",
    description:
      "Generate images from a text prompt with a GPT-image-class model. The images are saved to " +
      "disk and returned inline so you can see them. Use it for illustrations, icons, mockups, " +
      "textures, or any visual asset the user asks for.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "What to draw. Be concrete about subject, style, composition, and lighting.",
        },
        size: {
          type: "string",
          enum: ["auto", "1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792"],
          description: "Image dimensions. Defaults to the provider default (usually 1024x1024).",
        },
        quality: {
          type: "string",
          enum: ["auto", "low", "medium", "high", "standard", "hd"],
          description: "Rendering quality. Higher costs more and takes longer.",
        },
        background: {
          type: "string",
          enum: ["auto", "transparent", "opaque"],
          description: "Use transparent for assets that need alpha.",
        },
        output_format: OUTPUT_FORMAT,
        n: {
          type: "integer",
          minimum: 1,
          maximum: 4,
          description: "How many images to generate. Defaults to 1.",
        },
        model: { type: "string", description: "Override the configured image model." },
        filename: {
          type: "string",
          description: "Base name for the saved files, without extension. Defaults to a prompt slug.",
        },
        output_dir: {
          type: "string",
          description: "Directory to write into, relative to the current directory or absolute.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "edit_image",
    description:
      "Edit, restyle, or extend existing images with a GPT-image-class model. Pass one or more " +
      "source images plus a prompt describing the change; a mask limits the edit region.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The change to apply." },
        images: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Paths to source images (absolute, or relative to the current directory).",
        },
        mask: {
          type: "string",
          description: "Optional PNG mask path; transparent pixels mark the region to edit.",
        },
        size: {
          type: "string",
          enum: ["auto", "1024x1024", "1536x1024", "1024x1536"],
          description: "Output dimensions.",
        },
        quality: {
          type: "string",
          enum: ["auto", "low", "medium", "high"],
          description: "Rendering quality.",
        },
        n: { type: "integer", minimum: 1, maximum: 4 },
        model: { type: "string", description: "Override the configured image model." },
        filename: { type: "string", description: "Base name for the saved files." },
        output_dir: { type: "string", description: "Directory to write into." },
      },
      required: ["prompt", "images"],
    },
  },
];

function withOutputDir(cfg, requested) {
  if (!requested) return cfg;
  const dir = path.resolve(requested.replace(/^~(?=$|[\\/])/, process.env.HOME ?? ""));
  return { ...cfg, outputDir: dir };
}

async function callGenerate(args) {
  const cfg = withOutputDir(config(), args.output_dir);
  requireKey(cfg);
  const model = args.model ?? cfg.model;
  const payload = {
    model,
    prompt: args.prompt,
    n: args.n ?? 1,
    ...cfg.extra,
  };
  for (const key of ["size", "quality", "background", "output_format"]) {
    if (args[key] !== undefined) payload[key] = args[key];
  }

  const response = await postJson(cfg, "generations", payload);
  const images = await collectImages(cfg, response);
  const files = persist(cfg, images, args.filename, args.prompt);
  return resultContent(
    cfg,
    files,
    `Generated ${files.length} image${files.length === 1 ? "" : "s"} with ${model} ` +
      `(${payload.size ?? "default size"}, ${payload.quality ?? "default quality"}).`,
    response.usage,
  );
}

async function callEdit(args) {
  const cfg = withOutputDir(config(), args.output_dir);
  requireKey(cfg);
  const model = args.model ?? cfg.model;
  const files = args.images.map(readInputImage);
  const mask = args.mask ? readInputImage(args.mask) : undefined;
  const payload = {
    model,
    prompt: args.prompt,
    n: args.n ?? 1,
    ...cfg.extra,
  };
  for (const key of ["size", "quality"]) {
    if (args[key] !== undefined) payload[key] = args[key];
  }

  const response = await postMultipart(cfg, payload, files, mask);
  const images = await collectImages(cfg, response);
  const saved = persist(cfg, images, args.filename, args.prompt);
  return resultContent(
    cfg,
    saved,
    `Edited ${files.length} source image${files.length === 1 ? "" : "s"} with ${model}.`,
    response.usage,
  );
}

async function callTool(name, args) {
  try {
    if (name === "generate_image") return await callGenerate(args ?? {});
    if (name === "edit_image") return await callEdit(args ?? {});
    return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

// ---------------------------------------------------------------------------
// MCP over stdio
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      reply(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Generates and edits images through an OpenAI-compatible image API and saves them to disk. " +
          "Prefer calling generate_image whenever the user asks for a picture, icon, or illustration.",
      });
      return;
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      if (isRequest) reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const result = await callTool(params?.name, params?.arguments);
      reply(id, result);
      return;
    }
    case "resources/list":
      reply(id, { resources: [] });
      return;
    case "resources/templates/list":
      reply(id, { resourceTemplates: [] });
      return;
    case "prompts/list":
      reply(id, { prompts: [] });
      return;
    default:
      if (isRequest) replyError(id, -32601, `method not found: ${method}`);
  }
}

function serve() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid JSON" } });
        continue;
      }
      const batch = Array.isArray(message) ? message : [message];
      for (const item of batch) {
        handle(item).catch((error) => {
          const text = error instanceof Error ? error.message : String(error);
          if (item?.id !== undefined && item?.id !== null) replyError(item.id, -32603, text);
        });
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.stderr.write(`${SERVER_NAME} MCP server ready\n`);
}

// ---------------------------------------------------------------------------
// self check
// ---------------------------------------------------------------------------

async function check() {
  const cfg = config();
  const masked = cfg.apiKey
    ? `${cfg.apiKey.slice(0, 6)}...${cfg.apiKey.slice(-4)} (${cfg.apiKey.length} chars)`
    : "<missing>";
  console.log(`base url   ${cfg.baseUrl}`);
  console.log(`model      ${cfg.model}`);
  console.log(`api key    ${masked}`);
  console.log(`output dir ${cfg.outputDir}`);
  console.log(`inline     ${cfg.inline}`);
  if (!cfg.apiKey) {
    console.log("\nFAIL: no API key. Set IMAGE_API_KEY or OPENAI_API_KEY.");
    process.exit(1);
  }
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.text();
    if (res.ok) {
      console.log("\nOK: /models reachable");
    } else if (res.status === 404) {
      console.log("\nWARN: /models is 404 (normal on some relays); image endpoint not verified");
    } else {
      const hint = body.includes("images") ? " (provider says images are unsupported)" : "";
      console.log(`\nFAIL: /models responded ${res.status}${hint}: ${summarize(body)}`);
      process.exit(1);
    }
  } catch (error) {
    console.log(`\nFAIL: cannot reach ${cfg.baseUrl}: ${error.message}`);
    process.exit(1);
  }
  console.log("Tip: generate one image with --draw \"...\" to verify end to end (costs money).");
}

async function draw(prompt) {
  let result;
  try {
    result = await callGenerate({ prompt });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  for (const block of result.content) {
    if (block.type === "text") console.log(block.text);
    else console.log(`[image ${block.mimeType}, ${block.data.length} base64 chars]`);
  }
  if (result.isError) process.exit(1);
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
if (argv.includes("--check")) {
  await check();
} else if (argv.includes("--draw")) {
  const prompt = argv[argv.indexOf("--draw") + 1] ?? "a red fox in the snow, watercolor";
  await draw(prompt);
} else if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(HELP);
} else if (argv.includes("--version") || argv.includes("-v")) {
  console.log(SERVER_VERSION);
} else {
  serve();
}
