/**
 * Standalone Gateway example — no Chat SDK.
 *
 * Uses DiscordGatewayDO to receive Discord Gateway events and handle them
 * directly in a plain Cloudflare Worker. Useful when you want full control
 * over message handling without the Chat SDK abstraction.
 *
 * Required packages:
 *   npm install discord-gateway-cloudflare-do
 */

import {
  DiscordGatewayDO,
  getGatewayStub,
} from "discord-gateway-cloudflare-do";

// Re-export the Durable Object class so Cloudflare can instantiate it
export { DiscordGatewayDO };

interface Env {
  DISCORD_GATEWAY: DurableObjectNamespace<DiscordGatewayDO>;
  DISCORD_BOT_TOKEN: string;
}

/**
 * Forwarded Gateway event shape.
 * This is the format DiscordGatewayDO POSTs to your webhook URL.
 */
interface ForwardedEvent {
  type: `GATEWAY_${string}`;
  timestamp: number;
  data: unknown;
}

/** Subset of Discord's MESSAGE_CREATE payload we care about */
interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  author: { id: string; username: string; bot?: boolean };
  guild_id?: string;
  mentions?: Array<{ id: string }>;
}

/** Discord REST API base */
const DISCORD_API = "https://discord.com/api/v10";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── Webhook endpoint ─────────────────────────────────────────────
    // Receives forwarded Gateway events from DiscordGatewayDO
    if (url.pathname === "/webhook" && request.method === "POST") {
      // Verify the request came from our Gateway DO
      const token = request.headers.get("x-discord-gateway-token");
      if (token !== env.DISCORD_BOT_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }

      const event = await request.json() as ForwardedEvent;
      ctx.waitUntil(handleEvent(event, env));
      return new Response("OK", { status: 200 });
    }

    // ── Gateway management ───────────────────────────────────────────

    if (url.pathname === "/gateway/connect" && request.method === "POST") {
      const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY });
      const result = await gateway.connect({
        botToken: env.DISCORD_BOT_TOKEN,
        webhookUrl: `${url.origin}/webhook`,
      });
      return Response.json(result);
    }

    if (url.pathname === "/gateway/disconnect" && request.method === "POST") {
      const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY });
      const result = await gateway.disconnect();
      return Response.json(result);
    }

    if (url.pathname === "/gateway/status" && request.method === "GET") {
      const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY });
      return Response.json(await gateway.status());
    }

    return new Response("Not found", { status: 404 });
  },
};

// ── Event handling ─────────────────────────────────────────────────────

async function handleEvent(event: ForwardedEvent, env: Env): Promise<void> {
  switch (event.type) {
    case "GATEWAY_MESSAGE_CREATE":
      await handleMessage(event.data as DiscordMessage, env);
      break;
    case "GATEWAY_MESSAGE_REACTION_ADD":
      console.log("Reaction added:", event.data);
      break;
    case "GATEWAY_MESSAGE_REACTION_REMOVE":
      console.log("Reaction removed:", event.data);
      break;
  }
}

async function handleMessage(msg: DiscordMessage, env: Env): Promise<void> {
  // Ignore bot messages (including our own)
  if (msg.author.bot) return;

  // Simple echo: reply when someone says "!ping"
  if (msg.content.toLowerCase() === "!ping") {
    await sendMessage(msg.channel_id, "Pong! 🏓", env);
    return;
  }

  // Reply to DMs
  if (!msg.guild_id) {
    await sendMessage(msg.channel_id, `You said: ${msg.content}`, env);
    return;
  }
}

async function sendMessage(
  channelId: string,
  content: string,
  env: Env,
): Promise<void> {
  await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });
}
