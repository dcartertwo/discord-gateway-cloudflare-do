/**
 * Complete Chat SDK + Cloudflare Workers example.
 *
 * This Worker handles Discord messages via three mechanisms:
 * 1. HTTP Interactions (slash commands, button clicks) — Discord POSTs directly
 * 2. Gateway events (messages, reactions) — DiscordGatewayDO forwards via HTTP
 * 3. Management routes — connect/disconnect/status for the Gateway DO
 *
 * Both interaction types land on the same `/webhooks/discord` endpoint.
 * The Chat SDK's handleWebhook() auto-detects which type based on headers.
 *
 * Required packages:
 *   npm install chat @chat-adapter/discord chat-state-cloudflare-do discord-gateway-cloudflare-do
 */

import { Chat } from "chat";
import { createDiscordAdapter } from "@chat-adapter/discord";
import {
  createCloudflareState,
  ChatStateDO,
} from "chat-state-cloudflare-do";
import {
  DiscordGatewayDO,
  getGatewayStub,
} from "discord-gateway-cloudflare-do";

// Re-export Durable Object classes so Cloudflare can instantiate them
export { ChatStateDO, DiscordGatewayDO };

interface Env {
  // Durable Object bindings
  CHAT_STATE: DurableObjectNamespace<ChatStateDO>;
  DISCORD_GATEWAY: DurableObjectNamespace<DiscordGatewayDO>;

  // Discord credentials
  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
}

function createBot(env: Env) {
  const bot = new Chat({
    userName: "my-bot",
    adapters: {
      discord: createDiscordAdapter({
        botToken: env.DISCORD_BOT_TOKEN,
        publicKey: env.DISCORD_PUBLIC_KEY,
        applicationId: env.DISCORD_APPLICATION_ID,
      }),
    },
    state: createCloudflareState({ namespace: env.CHAT_STATE }),
  });

  // Respond to @mentions in new threads
  bot.onNewMention(async (thread, message) => {
    await thread.subscribe();
    await thread.post(`Hello! You said: ${message.text}`);
  });

  // Respond to messages in subscribed threads
  bot.onSubscribedMessage(async (thread, message) => {
    if (message.author.isMe) return; // Ignore own messages
    await thread.post(`Echo: ${message.text}`);
  });

  return bot;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── Webhook endpoint ─────────────────────────────────────────────
    // Handles both:
    //   - Discord HTTP Interactions (Ed25519 signed)
    //   - Forwarded Gateway events (x-discord-gateway-token header)
    if (url.pathname === "/webhooks/discord" && request.method === "POST") {
      const bot = createBot(env);
      return bot.webhooks.discord(request, { waitUntil: (p) => ctx.waitUntil(p) });
    }

    // ── Gateway management ───────────────────────────────────────────

    if (url.pathname === "/gateway/connect" && request.method === "POST") {
      const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY });
      const result = await gateway.connect({
        botToken: env.DISCORD_BOT_TOKEN,
        webhookUrl: `${url.origin}/webhooks/discord`,
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
      const status = await gateway.status();
      return Response.json(status);
    }

    return new Response("Not found", { status: 404 });
  },
};
