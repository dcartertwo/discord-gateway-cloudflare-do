import type { DiscordGatewayDO } from "./durable-object";

/**
 * Configuration for creating a Discord Gateway DO instance.
 */
export interface DiscordGatewayOptions {
  /**
   * DurableObjectNamespace binding for the DiscordGatewayDO class.
   * Must be bound in your wrangler config.
   *
   * @example
   * ```jsonc
   * // wrangler.jsonc
   * {
   *   "durable_objects": {
   *     "bindings": [
   *       { "name": "DISCORD_GATEWAY", "class_name": "DiscordGatewayDO" }
   *     ]
   *   },
   *   "migrations": [
   *     { "tag": "v1", "new_sqlite_classes": ["DiscordGatewayDO"] }
   *   ]
   * }
   * ```
   */
  namespace: DurableObjectNamespace<DiscordGatewayDO>;

  /**
   * Name for the DO instance. Defaults to `"default"`.
   * Use different names to run multiple bots (one DO per bot identity).
   *
   * @example
   * ```typescript
   * // Multi-agent: one gateway per agent
   * const gateway = createDiscordGateway({
   *   namespace: env.DISCORD_GATEWAY,
   *   name: agentId,
   * });
   * ```
   */
  name?: string;

  /**
   * Location hint for DO placement.
   * @see https://developers.cloudflare.com/durable-objects/reference/data-location/
   */
  locationHint?: DurableObjectLocationHint;
}

/**
 * Credentials required to connect to the Discord Gateway.
 */
export interface GatewayCredentials {
  /** Discord bot token */
  botToken: string;

  /** URL to forward Gateway events to (your Chat SDK webhook endpoint) */
  webhookUrl: string;

  /**
   * Optional secret used for webhook authentication.
   * If omitted, botToken is used for backward compatibility.
   */
  webhookSecret?: string;
}

/**
 * Strategy used for the next reconnect attempt.
 */
export type ReconnectStrategy = "resume-or-identify" | "identify-only";

/**
 * Persistent state stored in DO storage across reconnects.
 */
export interface GatewayState {
  /** WebSocket URL (updated with resume_gateway_url from READY) */
  wsUrl: string | null;

  /** Resume Gateway URL from READY (preferred for session resume reconnects) */
  resumeGatewayUrl: string | null;

  /** Session ID for resume (from READY payload) */
  sessionId: string | null;

  /** Last received sequence number (for resume and heartbeat) */
  sequence: number | null;

  /** Heartbeat interval in milliseconds (from Hello payload) */
  heartbeatIntervalMs: number | null;

  /** Timestamp of last heartbeat ack (for missed heartbeat detection) */
  lastHeartbeatAck: number | null;

  /** ISO timestamp of when the connection was established */
  connectedAt: string | null;

  /** Number of consecutive reconnect attempts (for backoff calculation) */
  reconnectAttempts: number;

  /** How the next reconnect should authenticate */
  reconnectStrategy: ReconnectStrategy;

  /** Timestamp (ms) after which Identify is allowed again, if rate-limited */
  identifyCooldownUntil: number | null;

  /** Session start limit metadata from /gateway/bot (best-effort tracking) */
  sessionStartRemaining: number | null;
  sessionStartResetAfterMs: number | null;
  sessionStartTotal: number | null;
  sessionStartMaxConcurrency: number | null;

  /** Terminal gateway state (non-reconnectable close code encountered) */
  reconnectDisabled: boolean;
}

/**
 * Stored credentials in DO storage.
 */
export interface StoredCredentials {
  botToken: string;
  webhookUrl: string;
  webhookSecret?: string;
}

/**
 * Status response from the Gateway DO.
 */
export interface GatewayStatus {
  status: "connected" | "disconnected" | "connecting";
  sessionId: string | null;
  connectedAt: string | null;
  sequence: number | null;
  reconnectAttempts: number;
}

/** /gateway/bot session start limits (Discord Gateway) */
export interface GatewaySessionStartLimit {
  total: number;
  remaining: number;
  reset_after: number;
  max_concurrency: number;
}

/** /gateway/bot response subset used by this package */
export interface GatewayBotResponse {
  url: string;
  session_start_limit?: GatewaySessionStartLimit;
}

// -- Discord Gateway protocol types ----------------------------------------

/** Discord Gateway opcodes (v10) */
export const GatewayOpcode = {
  /** Server → Client: Dispatched event */
  Dispatch: 0,
  /** Bidirectional: Heartbeat */
  Heartbeat: 1,
  /** Client → Server: Identify */
  Identify: 2,
  /** Client → Server: Resume */
  Resume: 6,
  /** Server → Client: Reconnect requested */
  Reconnect: 7,
  /** Server → Client: Invalid session */
  InvalidSession: 9,
  /** Server → Client: Hello (heartbeat interval) */
  Hello: 10,
  /** Server → Client: Heartbeat acknowledged */
  HeartbeatAck: 11,
} as const;

export type GatewayOpcodeValue =
  (typeof GatewayOpcode)[keyof typeof GatewayOpcode];

/** Gateway Hello payload (op 10) */
export interface GatewayHello {
  op: typeof GatewayOpcode.Hello;
  d: { heartbeat_interval: number };
}

/** Gateway Dispatch payload (op 0) */
export interface GatewayDispatch {
  op: typeof GatewayOpcode.Dispatch;
  t: string;
  s: number;
  d: unknown;
}

/** Gateway READY event data (dispatch t=READY) */
export interface GatewayReady {
  op: typeof GatewayOpcode.Dispatch;
  t: "READY";
  s: number;
  d: {
    session_id: string;
    resume_gateway_url?: string;
    user: { id: string; username: string };
  };
}

/** Gateway Reconnect payload (op 7) */
export interface GatewayReconnect {
  op: typeof GatewayOpcode.Reconnect;
}

/** Gateway Invalid Session payload (op 9) */
export interface GatewayInvalidSession {
  op: typeof GatewayOpcode.InvalidSession;
  d: boolean; // true = resumable
}

// -- Chat SDK forwarding types ---------------------------------------------

/** Event format expected by the Chat SDK's Discord adapter webhook handler */
export interface ForwardedGatewayEvent {
  type: `GATEWAY_${string}`;
  timestamp: number;
  data: unknown;
}

/**
 * Discord Gateway dispatch event types that the Chat SDK handles.
 * Only these events are forwarded to the webhook endpoint.
 */
export const FORWARDED_EVENT_TYPES = [
  "MESSAGE_CREATE",
  "MESSAGE_REACTION_ADD",
  "MESSAGE_REACTION_REMOVE",
] as const;

export type ForwardedEventType = (typeof FORWARDED_EVENT_TYPES)[number];
