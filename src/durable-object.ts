import { DurableObject } from "cloudflare:workers";
import {
  GatewayOpcode,
  FORWARDED_EVENT_TYPES,
  type GatewayState,
  type GatewayStatus,
  type GatewayCredentials,
  type StoredCredentials,
  type GatewayHello,
  type GatewayDispatch,
  type GatewayReady,
  type GatewayInvalidSession,
  type ForwardedGatewayEvent,
  type ForwardedEventType,
} from "./types";

const STATE_KEY = "gateway_state";
const CREDENTIALS_KEY = "credentials";

/** Discord Gateway API version */
const GATEWAY_VERSION = 10;

/** Discord Gateway Bot URL */
const GATEWAY_BOT_URL = "https://discord.com/api/v10/gateway/bot";

/**
 * Maximum reconnect backoff in milliseconds (5 minutes).
 * Prevents excessively long waits after many consecutive failures.
 */
const MAX_BACKOFF_MS = 300_000;

/**
 * Maximum reconnects allowed within the rate limit window.
 * Prevents runaway reconnect loops from consuming resources.
 *
 * Note: This is an in-memory counter — it resets if the DO is evicted.
 * The persistent `reconnectAttempts` in storage provides the primary
 * backoff protection across evictions; this is a secondary defense
 * against tight loops within a single DO lifetime.
 */
const RECONNECT_RATE_LIMIT = 5;

/** Rate limit window in milliseconds (60 seconds). */
const RECONNECT_RATE_WINDOW_MS = 60_000;

/** Fallback alarm delay when alarm() catches an unexpected error (30s). */
const ALARM_FALLBACK_DELAY_MS = 30_000;

/** Maximum webhook forward attempts (initial + retries). */
const WEBHOOK_MAX_ATTEMPTS = 2;

/** Delay before retrying a failed webhook forward (ms). */
const WEBHOOK_RETRY_DELAY_MS = 1_000;

/**
 * Discord Gateway Intents:
 * - GUILDS (1 << 0) — guild create/update/delete, role/channel events
 * - GUILD_MESSAGES (1 << 9) — message create/update/delete in guilds
 * - DIRECT_MESSAGES (1 << 12) — message create/update/delete in DMs
 * - MESSAGE_CONTENT (1 << 15) — message content in guild messages
 * - GUILD_MESSAGE_REACTIONS (1 << 10) — reaction add/remove in guilds
 * - DIRECT_MESSAGE_REACTIONS (1 << 13) — reaction add/remove in DMs
 */
const GATEWAY_INTENTS =
  (1 << 0) | (1 << 9) | (1 << 10) | (1 << 12) | (1 << 13) | (1 << 15);

/**
 * Durable Object that maintains a persistent WebSocket connection to the
 * Discord Gateway and forwards events to a webhook endpoint.
 *
 * Designed for Cloudflare Workers where discord.js and `startGatewayListener()`
 * cannot run. Replaces both with pure Cloudflare APIs (fetch with WebSocket
 * upgrade, DO storage, alarms).
 *
 * Events are forwarded as HTTP POSTs with the `x-discord-gateway-token` header,
 * matching the format that `@chat-adapter/discord`'s `handleWebhook()` expects
 * from `startGatewayListener()`.
 *
 * @example
 * ```typescript
 * import { DiscordGatewayDO } from "discord-gateway-cloudflare-do";
 *
 * // Re-export so Cloudflare can find it
 * export { DiscordGatewayDO };
 * ```
 */
// TEnv generic required by DurableObject base class but unused here.
export class DiscordGatewayDO<TEnv = unknown> extends DurableObject<TEnv> {
  /** In-memory WebSocket reference (lost on DO eviction, recovered via alarm) */
  private upstream: WebSocket | null = null;

  /** Sliding-window timestamps for reconnect rate limiting (in-memory only) */
  private reconnectTimestamps: number[] = [];

  /** Cached credentials (avoids storage reads on every message) */
  private cachedCredentials: StoredCredentials | null = null;

  /**
   * Sequential message processing queue. Prevents concurrent
   * handleGatewayMessage calls from racing on state updates
   * (especially sequence number writes during resume replays).
   */
  private messageQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: TEnv) {
    super(ctx, env);
  }

  // -- Public RPC methods --------------------------------------------------

  /**
   * Connect to the Discord Gateway.
   * Stores credentials and initiates the WebSocket connection.
   *
   * The connection is established asynchronously — this method returns
   * once the WebSocket is opened, but the Discord READY handshake
   * may still be in progress. Poll `status()` to confirm the
   * connection is fully established.
   *
   * @returns `{ status: "connecting" }` on success, `{ error: string }` on failure.
   */
  async connect(
    credentials: GatewayCredentials,
  ): Promise<{ status: string } | { error: string }> {
    if (!credentials.botToken || !credentials.webhookUrl) {
      return { error: "botToken and webhookUrl are required" };
    }

    // Validate webhookUrl is a valid HTTPS URL
    try {
      const parsed = new URL(credentials.webhookUrl);
      if (parsed.protocol !== "https:") {
        return { error: "webhookUrl must use HTTPS" };
      }
    } catch {
      return { error: "webhookUrl must be a valid URL" };
    }

    const stored: StoredCredentials = {
      botToken: credentials.botToken,
      webhookUrl: credentials.webhookUrl,
    };
    await this.ctx.storage.put(CREDENTIALS_KEY, stored);
    this.cachedCredentials = stored;

    await this.connectInternal();
    return { status: "connecting" };
  }

  /**
   * Disconnect from the Discord Gateway.
   * Closes the WebSocket and clears all state.
   */
  async disconnect(): Promise<{ status: string }> {
    await this.disconnectInternal();
    await this.ctx.storage.delete(CREDENTIALS_KEY);
    this.cachedCredentials = null;
    return { status: "disconnected" };
  }

  /**
   * Get the current Gateway connection status.
   */
  async status(): Promise<GatewayStatus> {
    const state = await this.loadState();
    return {
      status: this.upstream
        ? "connected"
        : state?.wsUrl
          ? "connecting"
          : "disconnected",
      sessionId: state?.sessionId ?? null,
      connectedAt: state?.connectedAt ?? null,
      sequence: state?.sequence ?? null,
      reconnectAttempts: state?.reconnectAttempts ?? 0,
    };
  }

  // -- DO alarm handler ----------------------------------------------------

  /**
   * Multi-purpose alarm handler:
   * - Sends heartbeats at the configured interval
   * - Detects missed heartbeat acks and reconnects
   * - Handles reconnect backoff delays
   * - Recovers from DO eviction (lost WebSocket reference)
   * - Handles invalid session re-identify delays
   * - Handles delayed reconnects (from op 7 Reconnect)
   *
   * Wrapped in try/catch to prevent permanent alarm loss after 6 retries.
   * Per Cloudflare docs, alarm() is retried up to 6 times on uncaught
   * exceptions. After that, the alarm is permanently lost. We catch all
   * errors and reschedule a fallback alarm to ensure recovery.
   */
  async alarm(): Promise<void> {
    try {
      await this.alarmInternal();
    } catch (error) {
      console.error("discord-gateway: alarm handler failed", {
        error: String(error),
      });
      // Always reschedule — prevents permanent alarm loss after 6 retries
      await this.ctx.storage.setAlarm(Date.now() + ALARM_FALLBACK_DELAY_MS);
    }
  }

  private async alarmInternal(): Promise<void> {
    const state = await this.loadState();

    // No state — nothing to do
    if (!state) return;

    // No wsUrl means we're in a backoff period or delayed reconnect — reconnect now
    if (!state.wsUrl) {
      await this.connectInternal();
      return;
    }

    // DO was evicted and restarted — WebSocket reference lost
    // Reconnect to re-establish it (will resume if session is valid)
    if (!this.upstream) {
      console.warn(
        "discord-gateway: WebSocket reference lost (DO eviction); reconnecting",
      );
      await this.ctx.storage.delete(STATE_KEY);
      await this.connectInternal();
      return;
    }

    // Heartbeat interval not set yet — this alarm was from an invalid
    // session delay. Re-identify/resume on the existing connection.
    if (!state.heartbeatIntervalMs) {
      await this.identifyOrResume(state);
      return;
    }

    // Check for missed heartbeat ack (2x interval threshold)
    const now = Date.now();
    const lastAck = state.lastHeartbeatAck ?? 0;
    if (now - lastAck > state.heartbeatIntervalMs * 2) {
      console.warn("discord-gateway: heartbeat missed; reconnecting");
      await this.reconnectWithBackoff();
      return;
    }

    // Send heartbeat and schedule the next one
    this.sendHeartbeat(state);
    await this.scheduleHeartbeat(state);
  }

  // -- Connection management -----------------------------------------------

  private async connectInternal(): Promise<void> {
    const state = await this.loadState();
    if (state?.wsUrl && this.upstream) return; // Already connected

    // Stale state — WebSocket lost (DO eviction)
    if (state?.wsUrl && !this.upstream) {
      await this.ctx.storage.delete(STATE_KEY);
    }

    const creds = await this.loadCredentials();
    if (!creds) {
      console.error("discord-gateway: no credentials stored; cannot connect");
      return;
    }

    const url = await this.getGatewayUrl(creds.botToken);
    if (!url) return;

    await this.openWebSocket(url);
  }

  private async disconnectInternal(): Promise<void> {
    if (this.upstream) {
      try {
        this.upstream.close(1000, "client disconnect");
      } catch {
        /* already closed */
      }
      this.upstream = null;
    }
    await this.ctx.storage.delete(STATE_KEY);
    // Cancel any pending alarm (heartbeat, backoff, etc.)
    await this.ctx.storage.deleteAlarm();
  }

  private async reconnectWithBackoff(): Promise<void> {
    const state = await this.loadState();
    const attempts = (state?.reconnectAttempts ?? 0) + 1;

    // Exponential backoff capped at MAX_BACKOFF_MS, with jitter
    const delay =
      Math.min(1000 * Math.pow(2, attempts), MAX_BACKOFF_MS) +
      Math.random() * 1000;

    if (state) {
      state.reconnectAttempts = attempts;
      await this.saveState(state);
    }

    // Close existing WebSocket
    if (this.upstream) {
      try {
        this.upstream.close(1000, "reconnecting with backoff");
      } catch {
        /* already closed */
      }
      this.upstream = null;
    }

    console.warn("discord-gateway: scheduling reconnect", {
      attempts,
      delayMs: Math.round(delay),
    });
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  /**
   * Schedule a delayed reconnect via alarm instead of blocking with setTimeout.
   * Used for op 7 (Reconnect) where Discord requires a minimum delay.
   */
  private async reconnectWithMinDelay(): Promise<void> {
    // Close existing connection
    if (this.upstream) {
      try {
        this.upstream.close(1000, "reconnecting");
      } catch {
        /* already closed */
      }
      this.upstream = null;
    }

    // Clear state so alarm handler knows to call connectInternal()
    const state = await this.loadState();
    if (state) {
      // Preserve session info for resume but clear wsUrl
      state.wsUrl = null;
      await this.saveState(state);
    }

    // Minimum 1-second delay via alarm — doesn't block the DO
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  /**
   * Sliding-window rate limiter: max RECONNECT_RATE_LIMIT reconnects
   * per RECONNECT_RATE_WINDOW_MS. Prevents runaway reconnect loops.
   *
   * Note: This counter is in-memory only — it resets on DO eviction.
   * The persistent `reconnectAttempts` backoff provides the primary
   * protection across evictions.
   */
  private isReconnectRateLimited(): boolean {
    const now = Date.now();
    this.reconnectTimestamps = this.reconnectTimestamps.filter(
      (t) => now - t < RECONNECT_RATE_WINDOW_MS,
    );
    return this.reconnectTimestamps.length >= RECONNECT_RATE_LIMIT;
  }

  // -- WebSocket management ------------------------------------------------

  private async openWebSocket(url: string): Promise<void> {
    const wsUrl = toHttpUrl(url) + `?v=${GATEWAY_VERSION}&encoding=json`;
    const response = await fetch(wsUrl, {
      headers: { Upgrade: "websocket" },
    });

    if (!response.webSocket) {
      console.error(
        `discord-gateway: failed to connect (${response.status})`,
      );
      await this.reconnectWithBackoff();
      return;
    }

    const ws = response.webSocket;
    ws.accept();
    this.upstream = ws;

    // Process messages sequentially via a promise chain to prevent
    // concurrent state mutations (especially sequence number races
    // during resume replays).
    ws.addEventListener("message", (evt) => {
      this.messageQueue = this.messageQueue
        .then(() => this.handleGatewayMessage(String(evt.data)))
        .catch((err) =>
          console.error("discord-gateway: message handler error", {
            error: String(err),
          }),
        );
      this.ctx.waitUntil(this.messageQueue);
    });

    // Guard against double reconnect: both `error` and `close` events fire
    // on WebSocket failure. The first handler to run sets upstream = null;
    // the second sees it's already null and skips.
    ws.addEventListener("close", (evt) => {
      if (!this.upstream) return; // Already handled by error event
      console.warn("discord-gateway: WebSocket closed", {
        code: evt.code,
        reason: evt.reason,
      });
      this.upstream = null;
      this.ctx.waitUntil(this.reconnectWithBackoff());
    });

    ws.addEventListener("error", (evt) => {
      if (!this.upstream) return; // Already handled by close event
      console.error("discord-gateway: WebSocket error", evt);
      this.upstream = null;
      this.ctx.waitUntil(this.reconnectWithBackoff());
    });

    await this.saveState({
      wsUrl: url,
      sessionId: null,
      sequence: null,
      heartbeatIntervalMs: null,
      lastHeartbeatAck: Date.now(),
      connectedAt: new Date().toISOString(),
      reconnectAttempts: 0,
    });
  }

  // -- Gateway message handling --------------------------------------------

  private async handleGatewayMessage(raw: string): Promise<void> {
    let payload: { op: number; t?: string; s?: number; d?: unknown };
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    const state = (await this.loadState()) ?? emptyState();

    // Track sequence number on every dispatch
    if (payload.s != null) {
      state.sequence = payload.s;
      await this.saveState(state);
    }

    switch (payload.op) {
      case GatewayOpcode.Hello:
        await this.handleHello(payload as GatewayHello, state);
        break;
      case GatewayOpcode.Dispatch:
        await this.handleDispatch(payload as GatewayDispatch, state);
        break;
      case GatewayOpcode.HeartbeatAck:
        await this.handleHeartbeatAck(state);
        break;
      case GatewayOpcode.Reconnect:
        await this.handleReconnect();
        break;
      case GatewayOpcode.InvalidSession:
        await this.handleInvalidSession(
          payload as GatewayInvalidSession,
          state,
        );
        break;
    }
  }

  private async handleHello(
    payload: GatewayHello,
    state: GatewayState,
  ): Promise<void> {
    state.heartbeatIntervalMs = payload.d.heartbeat_interval;
    await this.saveState(state);
    await this.identifyOrResume(state);
    await this.scheduleHeartbeat(state);
  }

  private async handleDispatch(
    payload: GatewayDispatch,
    state: GatewayState,
  ): Promise<void> {
    // READY — store session info for resume
    if (payload.t === "READY") {
      const ready = payload as GatewayReady;
      state.sessionId = ready.d.session_id;
      state.wsUrl = ready.d.resume_gateway_url ?? state.wsUrl;
      state.reconnectAttempts = 0;
      await this.saveState(state);
      console.log("discord-gateway: READY", {
        sessionId: state.sessionId,
        user: ready.d.user?.username,
      });
      return;
    }

    // RESUMED — reset backoff counter
    if (payload.t === "RESUMED") {
      state.reconnectAttempts = 0;
      await this.saveState(state);
      console.log("discord-gateway: RESUMED");
      return;
    }

    // Forward events the Chat SDK handles
    if (isForwardedEventType(payload.t)) {
      await this.forwardEvent(payload.t, payload.d);
    }
  }

  private async handleHeartbeatAck(state: GatewayState): Promise<void> {
    state.lastHeartbeatAck = Date.now();
    await this.saveState(state);
  }

  private async handleReconnect(): Promise<void> {
    console.warn("discord-gateway: server requested reconnect");
    if (this.isReconnectRateLimited()) {
      console.warn(
        "discord-gateway: reconnect rate limited — falling back to backoff",
      );
      await this.reconnectWithBackoff();
      return;
    }
    this.reconnectTimestamps.push(Date.now());
    await this.reconnectWithMinDelay();
  }

  private async handleInvalidSession(
    payload: GatewayInvalidSession,
    state: GatewayState,
  ): Promise<void> {
    console.warn("discord-gateway: invalid session", {
      resumable: payload.d,
    });
    // Only clear session info when not resumable
    if (!payload.d) {
      state.sessionId = null;
      state.sequence = null;
      await this.saveState(state);
    }
    // Discord requires 1-5s wait before re-identifying
    const delay = 1000 + Math.random() * 4000;
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  // -- Identify / Resume ---------------------------------------------------

  private async identifyOrResume(state: GatewayState): Promise<void> {
    const ws = this.upstream;
    if (!ws) return;

    const creds = await this.loadCredentials();
    if (!creds?.botToken) {
      console.error("discord-gateway: no bot token for identify/resume");
      return;
    }

    if (state.sessionId && state.sequence !== null) {
      // Resume existing session — Discord replays missed events
      ws.send(
        JSON.stringify({
          op: GatewayOpcode.Resume,
          d: {
            token: creds.botToken,
            session_id: state.sessionId,
            seq: state.sequence,
          },
        }),
      );
      return;
    }

    // Fresh identify
    ws.send(
      JSON.stringify({
        op: GatewayOpcode.Identify,
        d: {
          token: creds.botToken,
          intents: GATEWAY_INTENTS,
          properties: {
            os: "cloudflare",
            browser: "discord-gateway-cloudflare-do",
            device: "discord-gateway-cloudflare-do",
          },
        },
      }),
    );
  }

  // -- Heartbeat -----------------------------------------------------------

  private sendHeartbeat(state: GatewayState): void {
    const ws = this.upstream;
    if (!ws) return;
    ws.send(
      JSON.stringify({ op: GatewayOpcode.Heartbeat, d: state.sequence }),
    );
  }

  private async scheduleHeartbeat(state: GatewayState): Promise<void> {
    if (!state.heartbeatIntervalMs) return;
    await this.ctx.storage.setAlarm(Date.now() + state.heartbeatIntervalMs);
  }

  // -- Event forwarding (Chat SDK protocol) --------------------------------

  /**
   * Forward a Gateway event to the webhook endpoint.
   *
   * Uses the same protocol as `startGatewayListener()`:
   * - POST to the webhook URL
   * - `x-discord-gateway-token` header (botToken)
   * - Body: `{ type: "GATEWAY_<EVENT>", timestamp, data }`
   *
   * Retries once on failure with a short delay.
   */
  private async forwardEvent(
    eventType: string,
    data: unknown,
  ): Promise<void> {
    const creds = await this.loadCredentials();
    if (!creds) return;

    const event: ForwardedGatewayEvent = {
      type: `GATEWAY_${eventType}`,
      timestamp: Date.now(),
      data,
    };

    for (let attempt = 0; attempt < WEBHOOK_MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(creds.webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-discord-gateway-token": creds.botToken,
          },
          body: JSON.stringify(event),
        });

        if (response.ok) return; // Success

        const errorText = await response.text();
        console.error("discord-gateway: webhook forward failed", {
          type: event.type,
          status: response.status,
          error: errorText,
          attempt: attempt + 1,
        });

        // Don't retry on 4xx (client errors) — only retry on 5xx/network
        if (response.status >= 400 && response.status < 500) return;
      } catch (error) {
        console.error("discord-gateway: webhook forward error", {
          type: event.type,
          error: String(error),
          attempt: attempt + 1,
        });
      }

      // Wait before retry (only if there are more attempts)
      if (attempt < WEBHOOK_MAX_ATTEMPTS - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, WEBHOOK_RETRY_DELAY_MS),
        );
      }
    }
  }

  // -- Gateway URL resolution ----------------------------------------------

  private async getGatewayUrl(botToken: string): Promise<string | null> {
    try {
      const response = await fetch(GATEWAY_BOT_URL, {
        headers: { Authorization: `Bot ${botToken}` },
      });
      if (!response.ok) {
        console.error(
          `discord-gateway: GET /gateway/bot failed (${response.status})`,
        );
        return null;
      }
      const data = (await response.json()) as { url: string };
      return data.url;
    } catch (error) {
      console.error("discord-gateway: failed to get gateway URL", {
        error: String(error),
      });
      return null;
    }
  }

  // -- Storage helpers -----------------------------------------------------

  private async loadCredentials(): Promise<StoredCredentials | null> {
    if (this.cachedCredentials) return this.cachedCredentials;
    const creds =
      await this.ctx.storage.get<StoredCredentials>(CREDENTIALS_KEY);
    this.cachedCredentials = creds ?? null;
    return this.cachedCredentials;
  }

  private async loadState(): Promise<GatewayState | null> {
    const state = await this.ctx.storage.get<GatewayState>(STATE_KEY);
    return state ?? null;
  }

  private async saveState(state: GatewayState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
  }
}

// -- Helpers ---------------------------------------------------------------

function emptyState(): GatewayState {
  return {
    wsUrl: null,
    sessionId: null,
    sequence: null,
    heartbeatIntervalMs: null,
    lastHeartbeatAck: null,
    connectedAt: null,
    reconnectAttempts: 0,
  };
}

function isForwardedEventType(t: string): t is ForwardedEventType {
  return (FORWARDED_EVENT_TYPES as readonly string[]).includes(t);
}

/** Convert wss:// to https:// for Cloudflare's fetch-based WebSocket upgrade */
function toHttpUrl(url: string): string {
  if (url.startsWith("wss://")) return "https://" + url.slice(6);
  if (url.startsWith("ws://")) return "http://" + url.slice(5);
  return url;
}
