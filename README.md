# gpt-image-mcp

[![ci](https://github.com/TypeDreamMoon/gpt-image-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/TypeDreamMoon/gpt-image-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

An [MCP](https://modelcontextprotocol.io) server that lets coding agents **draw**. It wraps an
OpenAI-compatible `/v1/images` API and exposes it as two tools, so pi, Claude Code, Cursor, Codex,
and anything else that speaks MCP can generate and edit images as part of a normal task.

Text-only chat models cannot produce images, and most agent harnesses have no image tool. This fills
that gap: the model calls `generate_image`, gets the picture back **inline** (so it can actually look
at what it made) and a file on disk (so the next turn can reference, move, or ship it).

- Zero dependencies — one `server.mjs`, Node built-ins only
- Stdio transport, `2025-06-18` protocol (negotiates down to `2024-11-05`)
- Returns both image content blocks and saved files
- Never touches your key beyond the `Authorization` header

## Tools

| Tool | Purpose |
|---|---|
| `generate_image` | Text → image. `prompt`, `size`, `quality`, `background`, `output_format`, `n`, `model`, `filename`, `output_dir` |
| `edit_image` | Edit / restyle / extend existing images. `prompt`, `images[]`, `mask`, `size`, `quality`, `n` |

Both save every result to disk (`./generated-images` by default), print the paths, and attach the
images inline. Multiple results get `-1`, `-2` suffixes; name collisions are avoided automatically.
`b64_json` and `url` responses are both handled, so gpt-image and dall-e style providers both work.

## Quick start

```bash
# try it without installing (from this repo)
npx -y github:TypeDreamMoon/gpt-image-mcp --check

# or install globally
npm i -g github:TypeDreamMoon/gpt-image-mcp
```

`--check` prints the resolved configuration and probes the endpoint. It costs nothing.

```bash
export IMAGE_API_KEY=sk-...
node server.mjs --draw "a red fox in the snow, watercolor"   # costs one image
```

## Configure

Everything is an environment variable; there are no config files.

| Variable | Default | Notes |
|---|---|---|
| `IMAGE_API_KEY` | — | **Required.** Falls back to `OPENAI_API_KEY`, then `IMAGE_API_KEY_FILE` |
| `IMAGE_API_KEY_FILE` | — | Path to a file containing the key; wins over the two above |
| `IMAGE_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base; trailing `/` stripped |
| `IMAGE_MODEL` | `gpt-image-1` | Default model for both tools |
| `IMAGE_OUTPUT_DIR` | `<cwd>/generated-images` | Where images are written |
| `IMAGE_TIMEOUT_MS` | `240000` | Image models are slow; do not set this low |
| `IMAGE_INLINE` | `1` | Set to `0` to return paths only (saves context) |
| `IMAGE_EXTRA_JSON` | — | Extra JSON merged into the request body, for provider-specific fields |
| `IMAGE_EDIT_FIELD` | `image` / `image[]` | Multipart field name for edits, if a relay expects something else |

## Client setup

### pi

`~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "gpt-image-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/gpt-image-mcp/server.mjs"],
      "timeout": 300,
      "exposure": "direct",
      "env": { "IMAGE_API_KEY": "sk-...", "IMAGE_MODEL": "gpt-image-1" }
    }
  }
}
```

- `timeout: 300` — pi defaults to 60 seconds per request, which image generation will exceed.
- `exposure: "direct"` — declares the tools to the model up front. Use `"deferred"` to keep the tool
  list small behind `tool_search`, or omit it (default `codemode`) to reach the tools from scripts.

Check it: `pi mcp list` should report `gpt-image-mcp: connected, 2 tools`.

### Claude Code

```bash
claude mcp add gpt-image-mcp --scope user \
  --env IMAGE_API_KEY=sk-... --env IMAGE_MODEL=gpt-image-1 \
  -- node /absolute/path/to/gpt-image-mcp/server.mjs
claude mcp list
```

### Cursor, Claude Desktop, Codex, anything else

Use the standard `mcpServers` entry — `command`, `args`, `env` — wherever that client keeps its MCP
configuration. Codex takes the TOML equivalent under `[mcp_servers.gpt-image-mcp]`.

## Verify without spending money

```bash
node test.mjs
```

Runs a local mock of the OpenAI image API and drives the server over real stdio JSON-RPC: handshake,
`tools/list`, schema shape, generation, multipart editing, file saving, `output_dir` override, usage
passthrough, missing-key errors, provider 401s, and unknown tools. 18 checks, no network, no key.

## Provider requirements

The server needs an endpoint that implements the OpenAI images API:

```
POST {IMAGE_BASE_URL}/images/generations   ← generate_image
POST {IMAGE_BASE_URL}/images/edits         ← edit_image (multipart)
```

Official OpenAI (`gpt-image-1`, `gpt-image-1-mini`, dall-e) works out of the box. Many OpenAI-compatible
relays also expose `/v1/images/generations`; point `IMAGE_BASE_URL` at theirs and set
`IMAGE_MODEL` to the name they list.

⚠️ Plenty of chat-only relays advertise image models in `/v1/models` but return `404` on the images
endpoints, and some reject `image_generation` inside `/v1/responses`. Run `--check` and then `--draw`
before wiring it into an agent. A relay that only serves chat completions cannot be used here.

## Notes and limitations

- Images are returned inline by default. A 1024×1024 PNG is roughly 1–3 MB of base64, which costs
  context on every turn it stays in history; set `IMAGE_INLINE=0` to keep files only.
- No retries. Failures here are usually quota or moderation, which retrying will not fix — the
  provider's message is passed through verbatim.
- Generated images bypass any image downscaling the harness applies to files it reads.
- `edit_image` sends `multipart/form-data`; a few relays expect a JSON body with `images[].image_url`
  instead. That shape is not supported yet.

## Naming

The server identifies itself as `gpt-image-mcp` (config key, `initialize.serverInfo`) so it can sit
next to other image MCP servers without tool-name collisions. Environment variables keep the
`IMAGE_*` prefix; `OPENAI_API_KEY` is accepted as a last-resort key fallback.

## License

MIT
