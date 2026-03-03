export { DiscordGatewayDO } from "./durable-object";
export type {
  DiscordGatewayOptions,
  GatewayCredentials,
  GatewayStatus,
  GatewayState,
} from "./types";

import type { DiscordGatewayOptions } from "./types";
import type { DiscordGatewayDO } from "./durable-object";

/**
 * Helper to get a DiscordGatewayDO stub for a given configuration.
 *
 * This is a convenience for getting the right DO stub — the DO itself
 * handles all connection management via its RPC methods.
 *
 * @example
 * ```typescript
 * import { getGatewayStub, DiscordGatewayDO } from "discord-gateway-cloudflare-do";
 *
 * export { DiscordGatewayDO };
 *
 * // Get a stub and connect
 * const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY });
 * await gateway.connect({ botToken: env.DISCORD_BOT_TOKEN, webhookUrl });
 *
 * // Multi-agent: one gateway per agent
 * const gateway = getGatewayStub({
 *   namespace: env.DISCORD_GATEWAY,
 *   name: agentId,
 * });
 * ```
 */
export function getGatewayStub(
  options: DiscordGatewayOptions,
): DurableObjectStub<DiscordGatewayDO> {
  const name = options.name ?? "default";
  const id = options.namespace.idFromName(name);
  return options.locationHint
    ? options.namespace.get(id, { locationHint: options.locationHint })
    : options.namespace.get(id);
}
