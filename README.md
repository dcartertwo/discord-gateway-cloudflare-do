# discord-gateway-cloudflare-do

[![CI](https://github.com/dcartertwo/discord-gateway-cloudflare-do/actions/workflows/ci.yml/badge.svg)](https://github.com/dcartertwo/discord-gateway-cloudflare-do/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/discord-gateway-cloudflare-do)](https://www.npmjs.com/package/discord-gateway-cloudflare-do)
[![npm downloads](https://img.shields.io/npm/dm/discord-gateway-cloudflare-do)](https://www.npmjs.com/package/discord-gateway-cloudflare-do)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Persistent Discord Gateway WebSocket via [Durable Objects](https://developers.cloudflare.com/durable-objects/). Forwards messages and reactions to your Worker as HTTP POSTs — no discord.js, no Node.js, no cron.

```bash
npm install discord-gateway-cloudflare-do
```

## Quick Start

```typescript
import { DiscordGatewayDO, getGatewayStub } from "discord-gateway-cloudflare-do";

export { DiscordGatewayDO };

interface Env {
  DISCORD_GATEWAY: DurableObjectNamespace<DiscordGatewayDO>;
  DISCORD_BOT_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Receive forwarded Gateway events
    if (url.pathname === "/webhook" && request.method === "POST") {
      const token = request.headers.get("x-discord-gateway-token");
      if (token !== env.DISCORD_BOT_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
      const event = (await request.json()) as {
        type: string;
        timestamp: number;
        data: any;
      };
      console.log(event.type, event.data);
      return new Response("OK");
    }

    // Connect the Gateway (one-time — persists across deploys and evictions)
    if (url.pathname === "/connect" && request.method === "POST") {
      const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY });
      return Response.json(
        await gateway.connect({
          botToken: env.DISCORD_BOT_TOKEN,
          webhookUrl: `${url.origin}/webhook`,
        }),
      );
    }

    return new Response("Not found", { status: 404 });
  },
};
```

```jsonc
// wrangler.jsonc
{
  "name": "my-bot",
  "main": "src/index.ts",
  "compatibility_date": "2025-04-01",
  "durable_objects": {
    "bindings": [
      { "name": "DISCORD_GATEWAY", "class_name": "DiscordGatewayDO" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_classes": ["DiscordGatewayDO"] }
  ]
}
```

Deploy, then connect once:

```bash
npx wrangler deploy
curl -X POST https://my-bot.example.com/connect
```

That's it. The connection survives Worker redeployments and DO evictions.

## How It Works

```
                     ┌──────────────────────┐
                     │ Discord Gateway API  │
                     └──────────���───────────┘
                           WebSocket
                     ┌──────────┴───────────┐
                     │ DiscordGatewayDO     │
                     │  • heartbeat (alarm) │
                     │  • session resume    │
                     │  • auto-reconnect    │
                     └──────────┬───────────┘
                          HTTP POST
                  x-discord-gateway-token: <botToken>
                  { type, timestamp, data }
                     ┌──────────┴───────────┐
                     │ Your Worker          │
                     └──────────────────────┘
```

The DO maintains a WebSocket to Discord and forwards events as HTTP POSTs to your webhook URL with:
- Header: `x-discord-gateway-token: <botToken>`
- Body: `{ type: "GATEWAY_MESSAGE_CREATE", timestamp: 1234567890, data: { ... } }`

Only three event types are forwarded:

| Discord Event | Forwarded As |
|---|---|
| `MESSAGE_CREATE` | `GATEWAY_MESSAGE_CREATE` |
| `MESSAGE_REACTION_ADD` | `GATEWAY_MESSAGE_REACTION_ADD` |
| `MESSAGE_REACTION_REMOVE` | `GATEWAY_MESSAGE_REACTION_REMOVE` |

## API

### `getGatewayStub(options)`

Returns a typed DO stub.

```typescript
const gateway = getGatewayStub({
  namespace: env.DISCORD_GATEWAY, // required — DO namespace binding
  name: "default",                // optional — instance name (for multi-agent)
  locationHint: "enam",           // optional — DO location hint
});
```

### `gateway.connect(credentials)`

Stores credentials and opens a WebSocket to the Discord Gateway.

```typescript
await gateway.connect({
  botToken: "Bot MTk...",
  webhookUrl: "https://my-bot.example.com/webhook",
});
// → { status: "connecting" }
```

Returns `{ status: "connecting" }` on success, `{ error: string }` on failure. The webhook URL must be HTTPS.

### `gateway.disconnect()`

Closes the WebSocket and clears all stored credentials and state.

```typescript
await gateway.disconnect();
// → { status: "disconnected" }
```

### `gateway.status()`

```typescript
await gateway.status();
// → { status: "connected", sessionId: "...", connectedAt: "...", sequence: 42, reconnectAttempts: 0 }
```

Status is `"connected"`, `"connecting"`, or `"disconnected"`.

## Multi-Agent

One DO instance per bot — use the `name` parameter:

```typescript
const gateway = getGatewayStub({
  namespace: env.DISCORD_GATEWAY,
  name: agentId, // "agent-1", "agent-2", etc.
});

await gateway.connect({
  botToken: agentBotToken,
  webhookUrl: `https://my-app.example.com/webhook?agent=${agentId}`,
});
```

## Chat SDK

Drop-in replacement for the Chat SDK's `startGatewayListener()` — same forwarding format, so `handleWebhook()` accepts events without changes.

```bash
npm install chat @chat-adapter/discord chat-state-cloudflare-do discord-gateway-cloudflare-do
```

Both HTTP Interactions (slash commands) and forwarded Gateway events (messages, reactions) land on the same webhook endpoint. The Chat SDK auto-detects which type based on the `x-discord-gateway-token` header.

See [`examples/chat-sdk/`](./examples/chat-sdk) for a complete working example.

## Resilience

| Scenario | Behavior |
|---|---|
| **WebSocket close** | Exponential backoff (1s → 5min cap) with jitter |
| **Missed heartbeat** | Detected after 2× interval; triggers reconnect |
| **Op 7 (Reconnect)** | Immediate reconnect with 1s minimum delay |
| **Op 9 (Invalid Session)** | 1–5s random delay, then re-identify or resume |
| **DO eviction** | Next alarm detects lost WebSocket; reconnects |
| **Reconnect storm** | Rate limited (5 per 60s); falls back to backoff |

Session resume (op 6) replays missed events whenever a session ID and sequence number are available.

## Examples

Complete examples in [`examples/`](./examples):

| Example | Description |
|---|---|
| [`standalone/`](./examples/standalone) | Plain Worker, no framework — handle events directly |
| [`chat-sdk/`](./examples/chat-sdk) | Chat SDK + `@chat-adapter/discord` + `chat-state-cloudflare-do` |

## Development

```bash
npm install          # Install dependencies
npm run build        # Build with tsup
npm run typecheck    # TypeScript check
npm test             # Run tests (15 tests)
```

Zero dependencies — only imports from `cloudflare:workers` (provided by the runtime). 14KB bundled.

## License

MIT
