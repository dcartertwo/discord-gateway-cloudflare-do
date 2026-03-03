import { DurableObject } from "cloudflare:workers";
import {
  GatewayOpcode,
  FORWARDED_EVENT_TYPES,
  type GatewayState,
  type GatewayStatus,
  type GatewayCredentials,
  type StoredCredentials,
  type ReconnectStrategy,
  type GatewayHello,
  type GatewayDispatch,
  type GatewayReady,
  type GatewayInvalidSession,
  type ForwardedGatewayEvent,
  type ForwardedEventType,
  type GatewayBotResponse,
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
 * Close code used when intentionally restarting our own connection.
 * Must be client-valid: either 1000 or 3000-4999.
 */
const INTERNAL_RECONNECT_CLOSE_CODE = 3001;

/** Discord close codes that should not be retried. */
const NON_RECONNECTABLE_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

/**
 * Discord close codes where the next reconnect should start a fresh session.
 * 4003 (Not authenticated) may indicate a previously invalidated session.
 */
const NON_RESUMABLE_CLOSE_CODES = new Set([4003, 4007, 4009]);

type ConnectInternalResult =
  | { ok: true }
  | { ok: false; error: string; retryScheduled: boolean };

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

  /** True when a close was intentionally initiated by disconnect() */
  private suppressReconnect = false;

  /** True when we already scheduled reconnect before a close event arrives */
  private reconnectPlanned = false;

  /** In-memory fast flag for terminal (non-reconnectable) gateway state */
  private reconnectDisabled = false;

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
  ): Promise<{ status: "connecting" } | { error: string }> {
    if (!credentials.botToken || !credentials.webhookUrl) {
      return { error: "botToken and webhookUrl are required" };
    }

    // Validate webhookUrl is a valid HTTPS URL and safe target
    try {
      const parsed = new URL(credentials.webhookUrl);
      if (parsed.protocol !== "https:") {
        return { error: "webhookUrl must use HTTPS" };
      }
      if (parsed.username || parsed.password) {
        return { error: "webhookUrl must not contain credentials" };
      }
      if (isPrivateHostname(parsed.hostname)) {
        return { error: "webhookUrl host must be publicly routable" };
      }
    } catch {
      return { error: "webhookUrl must be a valid URL" };
    }

    const stored: StoredCredentials = {
      botToken: credentials.botToken,
      webhookUrl: credentials.webhookUrl,
      webhookSecret: credentials.webhookSecret,
    };
    await this.ctx.storage.put(CREDENTIALS_KEY, stored);
    this.cachedCredentials = stored;

    // Explicit connect() should clear terminal reconnect-disabled mode.
    const existingState = (await this.loadState()) ?? emptyState();
    existingState.reconnectDisabled = false;
    await this.saveState(existingState);
    this.reconnectDisabled = false;

    const result = await this.connectInternal();
    if (!result.ok && !result.retryScheduled) {
      return { error: result.error };
    }
    return { status: "connecting" };
  }

  /**
   * Disconnect from the Discord Gateway.
   * Closes the WebSocket and clears all state.
   */
  async disconnect(): Promise<{ status: "disconnected" }> {
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
    // Immediate in-memory guard for races with terminal close handling.
    if (this.reconnectDisabled) return;

    const state = await this.loadState();

    // No state can still happen if an alarm was scheduled before state persisted.
    // If credentials exist, attempt a best-effort reconnect instead of no-oping.
    if (!state) {
      const creds = await this.loadCredentials();
      if (!creds) return;
      await this.connectInternal();
      return;
    }

    if (state.reconnectDisabled) {
      this.reconnectDisabled = true;
      await this.ctx.storage.deleteAlarm();
      return;
    }

    // Identify cooldown window from /gateway/bot session_start_limit.
    if (state.identifyCooldownUntil && Date.now() < state.identifyCooldownUntil) {
      await this.ctx.storage.setAlarm(state.identifyCooldownUntil);
      return;
    }

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
      // Keep resumable state (sessionId/sequence/resume URL) and reconnect.
      state.wsUrl = null;
      state.heartbeatIntervalMs = null;
      await this.saveState(state);
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

  private async connectInternal(): Promise<ConnectInternalResult> {
    const state = (await this.loadState()) ?? emptyState();
    if (this.upstream) return { ok: true };

    if (state.reconnectDisabled) {
      return {
        ok: false,
        error: "reconnect disabled after terminal close code",
        retryScheduled: false,
      };
    }

    const creds = await this.loadCredentials();
    if (!creds) {
      const error = "no credentials stored; cannot connect";
      console.error(`discord-gateway: ${error}`);
      return { ok: false, error, retryScheduled: false };
    }

    const resumable = canResume(state);
    let gatewayUrl = resumable
      ? state.resumeGatewayUrl ?? state.wsUrl
      : state.wsUrl;

    if (!gatewayUrl) {
      const info = await this.getGatewayInfo(creds.botToken);
      if (!info.ok) {
        console.error("discord-gateway: failed to resolve gateway URL", {
          error: info.error,
          retryable: info.retryable,
          status: info.status,
        });
        if (info.retryable) {
          await this.reconnectWithBackoff({
            strategy: state.reconnectStrategy,
            reason: info.error,
          });
          return { ok: false, error: info.error, retryScheduled: true };
        }
        return { ok: false, error: info.error, retryScheduled: false };
      }

      gatewayUrl = info.url;
      if (info.sessionStartLimit) {
        state.sessionStartRemaining = info.sessionStartLimit.remaining;
        state.sessionStartResetAfterMs = info.sessionStartLimit.reset_after;
        state.sessionStartTotal = info.sessionStartLimit.total;
        state.sessionStartMaxConcurrency = info.sessionStartLimit.max_concurrency;
      }
    }

    const needsIdentify = !canResume(state);
    if (needsIdentify) {
      const now = Date.now();
      if (state.identifyCooldownUntil && now < state.identifyCooldownUntil) {
        await this.ctx.storage.setAlarm(state.identifyCooldownUntil);
        return {
          ok: false,
          error: "identify cooldown active",
          retryScheduled: true,
        };
      }

      if (
        state.sessionStartRemaining !== null &&
        state.sessionStartRemaining <= 0 &&
        state.sessionStartResetAfterMs &&
        state.sessionStartResetAfterMs > 0
      ) {
        state.identifyCooldownUntil = now + state.sessionStartResetAfterMs;
        state.wsUrl = null;
        await this.saveState(state);
        await this.ctx.storage.setAlarm(state.identifyCooldownUntil);
        return {
          ok: false,
          error: "session start limit exhausted; waiting for reset",
          retryScheduled: true,
        };
      }
    }

    state.wsUrl = gatewayUrl;
    state.heartbeatIntervalMs = null;
    state.lastHeartbeatAck = Date.now();
    state.connectedAt = new Date().toISOString();
    state.reconnectDisabled = false;
    await this.saveState(state);

    const openResult = await this.openWebSocket(gatewayUrl);
    if (!openResult.ok) {
      if (openResult.retryable) {
        await this.reconnectWithBackoff({
          strategy: state.reconnectStrategy,
          reason: openResult.error,
        });
      } else {
        state.wsUrl = null;
        await this.saveState(state);
      }
      return {
        ok: false,
        error: openResult.error,
        retryScheduled: openResult.retryable,
      };
    }

    return { ok: true };
  }

  private async disconnectInternal(): Promise<void> {
    if (this.upstream) {
      this.suppressReconnect = true;
      try {
        this.upstream.close(1000, "client disconnect");
      } catch {
        /* already closed */
      }
      this.upstream = null;
    }
    await this.ctx.storage.delete(STATE_KEY);
    this.reconnectDisabled = false;
    // Cancel any pending alarm (heartbeat, backoff, etc.)
    await this.ctx.storage.deleteAlarm();
  }

  private async reconnectWithBackoff(options?: {
    strategy?: ReconnectStrategy;
    clearSession?: boolean;
    reason?: string;
  }): Promise<void> {
    const state = (await this.loadState()) ?? emptyState();
    const attempts = state.reconnectAttempts + 1;

    // Exponential backoff capped at MAX_BACKOFF_MS, with jitter
    const delay =
      Math.min(1000 * Math.pow(2, attempts), MAX_BACKOFF_MS) +
      Math.random() * 1000;

    state.reconnectAttempts = attempts;
    state.wsUrl = null;
    state.heartbeatIntervalMs = null;
    state.reconnectStrategy = options?.strategy ?? state.reconnectStrategy;
    state.reconnectDisabled = false;

    if (options?.clearSession) {
      state.sessionId = null;
      state.sequence = null;
    }

    await this.saveState(state);

    // Close existing WebSocket
    if (this.upstream) {
      this.reconnectPlanned = true;
      try {
        this.upstream.close(INTERNAL_RECONNECT_CLOSE_CODE, "reconnecting");
      } catch {
        /* already closed */
      }
      this.upstream = null;
    }

    console.warn("discord-gateway: scheduling reconnect", {
      attempts,
      delayMs: Math.round(delay),
      strategy: state.reconnectStrategy,
      reason: options?.reason,
    });
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  /**
   * Schedule a delayed reconnect via alarm instead of blocking with setTimeout.
   * Used for op 7 (Reconnect) where Discord requires a minimum delay.
   */
  private async reconnectWithMinDelay(options?: {
    strategy?: ReconnectStrategy;
    clearSession?: boolean;
  }): Promise<void> {
    const state = (await this.loadState()) ?? emptyState();
    state.wsUrl = null;
    state.heartbeatIntervalMs = null;
    state.reconnectStrategy = options?.strategy ?? state.reconnectStrategy;
    state.reconnectDisabled = false;

    if (options?.clearSession) {
      state.sessionId = null;
      state.sequence = null;
    }

    await this.saveState(state);

    // Close existing connection
    if (this.upstream) {
      this.reconnectPlanned = true;
      try {
        this.upstream.close(INTERNAL_RECONNECT_CLOSE_CODE, "reconnecting");
      } catch {
        /* already closed */
      }
      this.upstream = null;
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

  private async openWebSocket(
    url: string,
  ): Promise<
    { ok: true } | { ok: false; error: string; retryable: boolean }
  > {
    const wsUrl = toHttpUrl(url) + `?v=${GATEWAY_VERSION}&encoding=json`;

    let response: Response;
    try {
      response = await fetch(wsUrl, {
        headers: { Upgrade: "websocket" },
      });
    } catch (error) {
      return {
        ok: false,
        error: `websocket upgrade request failed: ${String(error)}`,
        retryable: true,
      };
    }

    if (!response.webSocket) {
      const retryable =
        response.status === 429 || response.status >= 500 || response.status === 0;
      return {
        ok: false,
        error: `failed to connect (${response.status})`,
        retryable,
      };
    }

    const ws = response.webSocket;
    ws.accept();
    this.upstream = ws;
    this.suppressReconnect = false;
    this.reconnectPlanned = false;

    // Process messages sequentially via a promise chain to prevent
    // concurrent state mutations (especially sequence number races
    // during resume replays).
    ws.addEventListener("message", (evt) => {
      if (this.upstream !== ws) return;

      this.messageQueue = this.messageQueue
        .then(() => this.handleGatewayMessage(String(evt.data)))
        .catch((err) =>
          console.error("discord-gateway: message handler error", {
            error: String(err),
          }),
        );
    });

    // Guard against double reconnect: both `error` and `close` events may fire
    // on WebSocket failure. We only handle events for the currently active socket.
    ws.addEventListener("close", (evt) => {
      if (this.upstream !== ws) return;

      console.warn("discord-gateway: WebSocket closed", {
        code: evt.code,
        reason: evt.reason,
      });

      this.upstream = null;

      if (this.suppressReconnect) {
        this.suppressReconnect = false;
        return;
      }

      if (this.reconnectPlanned) {
        this.reconnectPlanned = false;
        return;
      }

      const policy = classifyCloseCode(evt.code);
      if (!policy.shouldReconnect) {
        // Set in-memory terminal mode immediately to avoid alarm races.
        this.reconnectDisabled = true;
        this.messageQueue = this.messageQueue
          .then(() => this.stopReconnecting(evt.code, evt.reason))
          .catch((error) =>
            console.error("discord-gateway: stopReconnecting failed", {
              error: String(error),
              code: evt.code,
            }),
          );
        return;
      }

      void this.reconnectWithBackoff({
        strategy: policy.canResume ? "resume-or-identify" : "identify-only",
        clearSession: !policy.canResume,
        reason: `close ${evt.code}: ${evt.reason}`,
      });
    });

    ws.addEventListener("error", (evt) => {
      if (this.upstream !== ws) return;
      console.error("discord-gateway: WebSocket error", evt);
      this.upstream = null;

      if (this.suppressReconnect) {
        this.suppressReconnect = false;
        return;
      }

      if (this.reconnectPlanned) return;

      void this.reconnectWithBackoff({
        strategy: "resume-or-identify",
        reason: "websocket error event",
      });
    });

    return { ok: true };
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
      case GatewayOpcode.Heartbeat:
        // Discord heartbeat request opcode: respond immediately.
        this.sendHeartbeat(state);
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
    state.lastHeartbeatAck = Date.now();
    await this.saveState(state);

    // Identify/Resume after Hello.
    await this.identifyOrResume(state);

    // Discord recommends first heartbeat at interval * jitter where jitter is [0, 1].
    const firstDelay = Math.floor(payload.d.heartbeat_interval * Math.random());
    await this.ctx.storage.setAlarm(Date.now() + firstDelay);
  }

  private async handleDispatch(
    payload: GatewayDispatch,
    state: GatewayState,
  ): Promise<void> {
    // READY — store session info for resume
    if (payload.t === "READY") {
      const ready = payload as GatewayReady;
      state.sessionId = ready.d.session_id;
      state.resumeGatewayUrl = ready.d.resume_gateway_url ?? state.resumeGatewayUrl;
      state.reconnectAttempts = 0;
      state.reconnectStrategy = "resume-or-identify";
      state.identifyCooldownUntil = null;
      state.reconnectDisabled = false;
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
      state.reconnectStrategy = "resume-or-identify";
      state.reconnectDisabled = false;
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
      await this.reconnectWithBackoff({ strategy: "resume-or-identify" });
      return;
    }
    this.reconnectTimestamps.push(Date.now());
    await this.reconnectWithMinDelay({ strategy: "resume-or-identify" });
  }

  private async handleInvalidSession(
    payload: GatewayInvalidSession,
    state: GatewayState,
  ): Promise<void> {
    console.warn("discord-gateway: invalid session", {
      resumable: payload.d,
    });
    // d=true means resume can be attempted; d=false requires new identify.
    state.reconnectStrategy = payload.d ? "resume-or-identify" : "identify-only";

    if (!payload.d) {
      state.sessionId = null;
      state.sequence = null;
    }

    state.wsUrl = null;
    state.heartbeatIntervalMs = null;
    await this.saveState(state);

    // Close current socket before delayed reconnect.
    if (this.upstream) {
      this.reconnectPlanned = true;
      try {
        this.upstream.close(INTERNAL_RECONNECT_CLOSE_CODE, "invalid session");
      } catch {
        /* already closed */
      }
      this.upstream = null;
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

    if (canResume(state)) {
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

    // Identify budget/cooldown checks for non-resume handshakes.
    const now = Date.now();
    if (state.identifyCooldownUntil && now < state.identifyCooldownUntil) {
      state.wsUrl = null;
      await this.saveState(state);
      if (this.upstream === ws) {
        this.reconnectPlanned = true;
        try {
          ws.close(INTERNAL_RECONNECT_CLOSE_CODE, "identify cooldown");
        } catch {
          /* already closed */
        }
        this.upstream = null;
      }
      await this.ctx.storage.setAlarm(state.identifyCooldownUntil);
      return;
    }

    if (
      state.sessionStartRemaining !== null &&
      state.sessionStartRemaining <= 0 &&
      state.sessionStartResetAfterMs &&
      state.sessionStartResetAfterMs > 0
    ) {
      state.identifyCooldownUntil = now + state.sessionStartResetAfterMs;
      state.wsUrl = null;
      await this.saveState(state);
      if (this.upstream === ws) {
        this.reconnectPlanned = true;
        try {
          ws.close(INTERNAL_RECONNECT_CLOSE_CODE, "session start limit exhausted");
        } catch {
          /* already closed */
        }
        this.upstream = null;
      }
      await this.ctx.storage.setAlarm(state.identifyCooldownUntil);
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

    if (state.sessionStartRemaining !== null && state.sessionStartRemaining > 0) {
      state.sessionStartRemaining -= 1;
    }
    state.identifyCooldownUntil = null;
    state.reconnectStrategy = "resume-or-identify";
    await this.saveState(state);
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
    * - `x-discord-gateway-token` header (webhookSecret or botToken fallback)
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
            "x-discord-gateway-token": creds.webhookSecret ?? creds.botToken,
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
        await scheduler.wait(WEBHOOK_RETRY_DELAY_MS);
      }
    }
  }

  // -- Gateway URL resolution ----------------------------------------------

  private async getGatewayInfo(botToken: string): Promise<
    | {
        ok: true;
        url: string;
        sessionStartLimit: GatewayBotResponse["session_start_limit"];
      }
    | { ok: false; error: string; retryable: boolean; status?: number }
  > {
    try {
      const response = await fetch(GATEWAY_BOT_URL, {
        headers: { Authorization: `Bot ${botToken}` },
      });

      if (!response.ok) {
        return {
          ok: false,
          error: `GET /gateway/bot failed (${response.status})`,
          retryable:
            response.status === 429 ||
            response.status >= 500 ||
            response.status === 408,
          status: response.status,
        };
      }

      const data = (await response.json()) as GatewayBotResponse;
      if (!data.url) {
        return {
          ok: false,
          error: "GET /gateway/bot returned no URL",
          retryable: true,
        };
      }

      return {
        ok: true,
        url: data.url,
        sessionStartLimit: data.session_start_limit,
      };
    } catch (error) {
      return {
        ok: false,
        error: `failed to get gateway URL: ${String(error)}`,
        retryable: true,
      };
    }
  }

  private async stopReconnecting(code: number, reason: string): Promise<void> {
    const state = (await this.loadState()) ?? emptyState();
    const policy = classifyCloseCode(code);

    this.reconnectDisabled = true;
    state.wsUrl = null;
    state.heartbeatIntervalMs = null;
    state.reconnectDisabled = true;
    if (!policy.canResume) {
      state.sessionId = null;
      state.sequence = null;
      state.reconnectStrategy = "identify-only";
    }

    await this.saveState(state);
    await this.ctx.storage.deleteAlarm();

    console.error("discord-gateway: stopped reconnecting due to close code", {
      code,
      reason,
    });
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
    const state = await this.ctx.storage.get<Partial<GatewayState>>(STATE_KEY);
    if (!state) return null;
    return normalizeState(state);
  }

  private async saveState(state: GatewayState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
  }
}

// -- Helpers ---------------------------------------------------------------

function emptyState(): GatewayState {
  return {
    wsUrl: null,
    resumeGatewayUrl: null,
    sessionId: null,
    sequence: null,
    heartbeatIntervalMs: null,
    lastHeartbeatAck: null,
    connectedAt: null,
    reconnectAttempts: 0,
    reconnectStrategy: "resume-or-identify",
    identifyCooldownUntil: null,
    sessionStartRemaining: null,
    sessionStartResetAfterMs: null,
    sessionStartTotal: null,
    sessionStartMaxConcurrency: null,
    reconnectDisabled: false,
  };
}

function normalizeState(state: Partial<GatewayState>): GatewayState {
  return {
    ...emptyState(),
    ...state,
    reconnectAttempts: state.reconnectAttempts ?? 0,
    reconnectStrategy: state.reconnectStrategy ?? "resume-or-identify",
    reconnectDisabled: state.reconnectDisabled ?? false,
  };
}

function canResume(state: GatewayState): boolean {
  return (
    state.reconnectStrategy !== "identify-only" &&
    !!state.sessionId &&
    state.sequence !== null
  );
}

function classifyCloseCode(code: number): {
  shouldReconnect: boolean;
  canResume: boolean;
} {
  const shouldReconnect = !NON_RECONNECTABLE_CLOSE_CODES.has(code);
  const canResume = shouldReconnect && !NON_RESUMABLE_CLOSE_CODES.has(code);
  return { shouldReconnect, canResume };
}

function isPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local")
  ) {
    return true;
  }

  if (isPrivateIpv4(lower) || isPrivateIpv6(lower)) {
    return true;
  }

  return false;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;

  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;

  const [a, b] = nums;

  // Loopback, private, link-local, unspecified
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIpv6(host: string): boolean {
  // Handle IPv4-mapped IPv6 literals (e.g. ::ffff:127.0.0.1)
  if (host.includes(".")) {
    const ipv4 = host.slice(host.lastIndexOf(":") + 1);
    if (isPrivateIpv4(ipv4)) return true;
  }

  const lower = host.toLowerCase();

  // Loopback/unspecified
  if (lower === "::1" || lower === "::") return true;

  // Unique local fc00::/7 and link-local fe80::/10
  return /^f[c-d]/i.test(lower) || /^fe[89ab]/i.test(lower);
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
