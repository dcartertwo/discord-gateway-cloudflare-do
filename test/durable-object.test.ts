import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import { DiscordGatewayDO } from "../src/durable-object";
import { GatewayOpcode, type GatewayState } from "../src/types";

const STATE_KEY = "gateway_state";
const CREDENTIALS_KEY = "credentials";

function makeState(overrides: Partial<GatewayState> = {}): GatewayState {
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
    ...overrides,
  };
}

function getStub() {
  const id = env.DISCORD_GATEWAY.idFromName("test-" + Math.random());
  return env.DISCORD_GATEWAY.get(id);
}

function fakeWebSocket() {
  return {
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
}

function makeEventedWebSocket() {
  const listeners: Record<string, (evt: any) => void> = {};
  const ws = {
    send: vi.fn(),
    close: vi.fn(),
    accept: vi.fn(),
    addEventListener: vi.fn((type: string, cb: (evt: any) => void) => {
      listeners[type] = cb;
    }),
  } as unknown as WebSocket;

  return {
    ws,
    emitMessage: (data: string) => listeners.message?.({ data }),
    emitClose: (code: number, reason = "") => listeners.close?.({ code, reason }),
    emitError: (error: unknown = new Error("ws error")) =>
      listeners.error?.(error),
  };
}

describe("DiscordGatewayDO", () => {
  // -- connect / disconnect / status (via RPC) -----------------------------

  describe("connect", () => {
    it("rejects missing botToken", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-missing-token");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          const res = await instance.connect({
            botToken: "",
            webhookUrl: "https://example.com/webhooks/discord",
          });
          expect("error" in res).toBe(true);
          expect((res as { error: string }).error).toContain("botToken");
        },
      );
    });

    it("rejects missing webhookUrl", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-missing-webhook");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          const res = await instance.connect({
            botToken: "Bot token.here",
            webhookUrl: "",
          });
          expect("error" in res).toBe(true);
        },
      );
    });

    it("rejects non-HTTPS webhookUrl", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-http-webhook");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          const res = await instance.connect({
            botToken: "Bot token.here",
            webhookUrl: "http://example.com/webhooks/discord",
          });
          expect("error" in res).toBe(true);
          expect((res as { error: string }).error).toContain("HTTPS");
        },
      );
    });

    it("rejects invalid webhookUrl", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-invalid-webhook");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          const res = await instance.connect({
            botToken: "Bot token.here",
            webhookUrl: "not-a-url",
          });
          expect("error" in res).toBe(true);
          expect((res as { error: string }).error).toContain("valid URL");
        },
      );
    });

    it("rejects webhookUrl with embedded credentials", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-webhook-credentials");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          const res = await instance.connect({
            botToken: "token",
            webhookUrl: "https://user:pass@example.com/webhooks/discord",
          });
          expect("error" in res).toBe(true);
          expect((res as { error: string }).error).toContain("credentials");
        },
      );
    });

    it("rejects private/local webhook hosts", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-private-webhook-host");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          const res = await instance.connect({
            botToken: "token",
            webhookUrl: "https://localhost/webhooks/discord",
          });
          expect("error" in res).toBe(true);
          expect((res as { error: string }).error).toContain("publicly routable");
        },
      );
    });

    it("stores credentials in DO storage", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-creds");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          vi.spyOn(instance as any, "connectInternal").mockResolvedValue({
            ok: true,
          });

          const res = await instance.connect({
            botToken: "test-token",
            webhookUrl: "https://example.com/webhooks/discord",
            webhookSecret: "gateway-secret",
          });
          expect(res).toEqual({ status: "connecting" });

          const creds = await instance.ctx.storage.get(CREDENTIALS_KEY);
          expect(creds).toEqual({
            botToken: "test-token",
            webhookUrl: "https://example.com/webhooks/discord",
            webhookSecret: "gateway-secret",
          });
        },
      );
    });

    it("clears reconnectDisabled terminal state on explicit connect", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-connect-clears-terminal-state");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          await instance.ctx.storage.put(
            STATE_KEY,
            makeState({
              reconnectDisabled: true,
              reconnectStrategy: "identify-only",
            }),
          );

          vi.spyOn(instance as any, "connectInternal").mockResolvedValue({
            ok: true,
          });

          const result = await instance.connect({
            botToken: "test-token",
            webhookUrl: "https://example.com/webhooks/discord",
          });

          expect(result).toEqual({ status: "connecting" });
          const state = await instance.ctx.storage.get<GatewayState>(STATE_KEY);
          expect(state?.reconnectDisabled).toBe(false);
        },
      );
    });
  });

  describe("disconnect", () => {
    it("clears credentials and state", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-disconnect");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          // Set up some state
          await instance.ctx.storage.put(CREDENTIALS_KEY, {
            botToken: "test-token",
            webhookUrl: "https://example.com/webhooks/discord",
          });
          await instance.ctx.storage.put(
            STATE_KEY,
            makeState({
              wsUrl: "wss://gateway.discord.gg",
              sessionId: "session-123",
              sequence: 42,
              heartbeatIntervalMs: 41250,
              lastHeartbeatAck: Date.now(),
              connectedAt: new Date().toISOString(),
              reconnectAttempts: 0,
            }),
          );

          const res = await instance.disconnect();
          expect(res.status).toBe("disconnected");

          const creds = await instance.ctx.storage.get(CREDENTIALS_KEY);
          expect(creds).toBeUndefined();

          const state = await instance.ctx.storage.get(STATE_KEY);
          expect(state).toBeUndefined();
        },
      );
    });
  });

  describe("status", () => {
    it("returns disconnected when no state", async () => {
      const stub = getStub();
      const res = await stub.status();
      expect(res.status).toBe("disconnected");
    });

    it("returns connecting when state exists but no WebSocket", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-status-connecting");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          await instance.ctx.storage.put(
            STATE_KEY,
            makeState({
              wsUrl: "wss://gateway.discord.gg",
              sessionId: "session-123",
              sequence: 42,
              heartbeatIntervalMs: 41250,
              lastHeartbeatAck: Date.now(),
              connectedAt: new Date().toISOString(),
              reconnectAttempts: 0,
            }),
          );

          const result = await instance.status();
          expect(result.status).toBe("connecting");
          expect(result.sessionId).toBe("session-123");
          expect(result.sequence).toBe(42);
        },
      );
    });
  });

  // -- alarm handler -------------------------------------------------------

  describe("alarm", () => {
    it("does nothing with no state", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-alarm-empty");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          // Should not throw
          await instance.alarm();
        },
      );
    });

    it("attempts reconnect when wsUrl is null (backoff period)", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-alarm-backoff");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          await instance.ctx.storage.put(CREDENTIALS_KEY, {
            botToken: "test-token",
            webhookUrl: "https://example.com/webhooks/discord",
          });
          await instance.ctx.storage.put(
            STATE_KEY,
            makeState({
              wsUrl: null,
              reconnectAttempts: 1,
            }),
          );

          // alarm() will attempt to connect, which will fail (no Discord)
          // but shouldn't throw
          await instance.alarm();
        },
      );
    });

    it("detects DO eviction (state exists, no WebSocket)", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-alarm-eviction");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          await instance.ctx.storage.put(CREDENTIALS_KEY, {
            botToken: "test-token",
            webhookUrl: "https://example.com/webhooks/discord",
          });
          await instance.ctx.storage.put(
            STATE_KEY,
            makeState({
              wsUrl: "wss://gateway.discord.gg",
              sessionId: "session-123",
              sequence: 42,
              heartbeatIntervalMs: 41250,
              lastHeartbeatAck: Date.now(),
              connectedAt: new Date().toISOString(),
              reconnectAttempts: 0,
            }),
          );

          // No upstream WebSocket (simulates DO eviction).
          // alarm() should clear stale state and attempt reconnect.
          await instance.alarm();

          // Stale state should be cleared
          const state =
            await instance.ctx.storage.get<GatewayState>(STATE_KEY);
          // State is either cleared or preserved for resume during reconnect.
          if (state) {
            expect(state.wsUrl).toBeNull();
            expect(state.sessionId).toBe("session-123");
          }
        },
      );
    });
  });

  // -- protocol and resilience behaviors -----------------------------------

  describe("protocol behaviors", () => {
    it("responds to server heartbeat request opcode immediately", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-opcode-heartbeat");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          const ws = fakeWebSocket();
          (instance as any).upstream = ws;

          await instance.ctx.storage.put(
            STATE_KEY,
            makeState({
              wsUrl: "wss://gateway.discord.gg",
              sequence: 42,
            }),
          );

          await (instance as any).handleGatewayMessage(
            JSON.stringify({ op: GatewayOpcode.Heartbeat, d: null }),
          );

          expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
          const payload = JSON.parse(
            (ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0],
          );
          expect(payload.op).toBe(GatewayOpcode.Heartbeat);
          expect(payload.d).toBe(42);
        },
      );
    });

    it("uses first heartbeat jitter after hello", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-first-heartbeat-jitter");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          const ws = fakeWebSocket();
          (instance as any).upstream = ws;

          await instance.ctx.storage.put(CREDENTIALS_KEY, {
            botToken: "test-token",
            webhookUrl: "https://example.com/webhook",
          });
          await instance.ctx.storage.put(
            STATE_KEY,
            makeState({
              wsUrl: "wss://gateway.discord.gg",
            }),
          );

          const now = Date.now();
          await (instance as any).handleGatewayMessage(
            JSON.stringify({
              op: GatewayOpcode.Hello,
              d: { heartbeat_interval: 4000 },
            }),
          );

          const nextAlarm = await instance.ctx.storage.getAlarm();
          expect(nextAlarm).not.toBeNull();
          expect(nextAlarm!).toBeGreaterThanOrEqual(now);
          expect(nextAlarm!).toBeLessThanOrEqual(now + 4000);
        },
      );
    });

    it("uses resume gateway URL when reconnecting resumable sessions", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-resume-url-preferred");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          await instance.ctx.storage.put(CREDENTIALS_KEY, {
            botToken: "test-token",
            webhookUrl: "https://example.com/webhook",
          });
          await instance.ctx.storage.put(
            STATE_KEY,
            makeState({
              sessionId: "session-123",
              sequence: 42,
              resumeGatewayUrl: "wss://resume.discord.gg",
              reconnectStrategy: "resume-or-identify",
            }),
          );

          const openSpy = vi
            .spyOn(instance as any, "openWebSocket")
            .mockResolvedValue({ ok: true });
          const gatewaySpy = vi.spyOn(instance as any, "getGatewayInfo");

          const result = await (instance as any).connectInternal();
          expect(result.ok).toBe(true);
          expect(openSpy).toHaveBeenCalledWith("wss://resume.discord.gg");
          expect(gatewaySpy).not.toHaveBeenCalled();
        },
      );
    });

    it("clears session and switches to identify-only on non-resumable invalid session", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-invalid-session-hard");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          const ws = fakeWebSocket();
          (instance as any).upstream = ws;

          const state = makeState({
            wsUrl: "wss://gateway.discord.gg",
            sessionId: "session-123",
            sequence: 42,
          });

          await (instance as any).handleInvalidSession(
            { op: GatewayOpcode.InvalidSession, d: false },
            state,
          );

          const stored = await instance.ctx.storage.get<GatewayState>(STATE_KEY);
          expect(stored?.sessionId).toBeNull();
          expect(stored?.sequence).toBeNull();
          expect(stored?.reconnectStrategy).toBe("identify-only");
          expect(stored?.wsUrl).toBeNull();
        },
      );
    });

    it("keeps session and uses resume strategy on resumable invalid session", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-invalid-session-soft");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          const ws = fakeWebSocket();
          (instance as any).upstream = ws;

          const state = makeState({
            wsUrl: "wss://gateway.discord.gg",
            sessionId: "session-123",
            sequence: 42,
          });

          await (instance as any).handleInvalidSession(
            { op: GatewayOpcode.InvalidSession, d: true },
            state,
          );

          const stored = await instance.ctx.storage.get<GatewayState>(STATE_KEY);
          expect(stored?.sessionId).toBe("session-123");
          expect(stored?.sequence).toBe(42);
          expect(stored?.reconnectStrategy).toBe("resume-or-identify");
          expect(stored?.wsUrl).toBeNull();
        },
      );
    });

    it("returns error on non-retryable bootstrap failure", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-connect-auth-failure");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          vi.spyOn(instance as any, "getGatewayInfo").mockResolvedValue({
            ok: false,
            error: "auth failed",
            retryable: false,
            status: 401,
          });

          const result = await instance.connect({
            botToken: "bad-token",
            webhookUrl: "https://example.com/webhook",
          });

          expect("error" in result).toBe(true);
          expect((result as { error: string }).error).toContain("auth failed");
        },
      );
    });

    it("marks gateway disconnected for non-reconnectable close codes", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-stop-reconnecting");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          await instance.ctx.storage.put(
            STATE_KEY,
            makeState({
              wsUrl: "wss://gateway.discord.gg",
              sessionId: "session-123",
              sequence: 42,
            }),
          );

          await (instance as any).stopReconnecting(4004, "auth failed");

          const stored = await instance.ctx.storage.get<GatewayState>(STATE_KEY);
          expect(stored?.wsUrl).toBeNull();
          expect(stored?.sessionId).toBeNull();
          expect(stored?.sequence).toBeNull();
          expect(stored?.reconnectStrategy).toBe("identify-only");
        },
      );
    });

    it("treats close code 4003 as non-resumable and schedules identify-only reconnect", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-close-4003");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          await instance.ctx.storage.put(
            STATE_KEY,
            makeState({
              wsUrl: "wss://gateway.discord.gg",
              resumeGatewayUrl: "wss://resume.discord.gg",
              sessionId: "session-123",
              sequence: 42,
              reconnectStrategy: "resume-or-identify",
            }),
          );

          const { ws, emitClose } = makeEventedWebSocket();
          const response = {
            status: 101,
            webSocket: ws,
          } as unknown as Response;

          const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

          const result = await (instance as any).openWebSocket("wss://gateway.discord.gg");
          expect(result.ok).toBe(true);

          emitClose(4003, "not authenticated");
          await scheduler.wait(0);

          const stored = await instance.ctx.storage.get<GatewayState>(STATE_KEY);
          expect(stored?.reconnectStrategy).toBe("identify-only");
          expect(stored?.sessionId).toBeNull();
          expect(stored?.sequence).toBeNull();

          const alarm = await instance.ctx.storage.getAlarm();
          expect(alarm).not.toBeNull();

          fetchSpy.mockRestore();
        },
      );
    });

    it("stops reconnecting on non-reconnectable close code 4014", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-close-4014");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          await instance.ctx.storage.put(
            STATE_KEY,
            makeState({
              wsUrl: "wss://gateway.discord.gg",
              sessionId: "session-123",
              sequence: 42,
            }),
          );
          await instance.ctx.storage.setAlarm(Date.now() + 60_000);

          const { ws, emitClose } = makeEventedWebSocket();
          const response = {
            status: 101,
            webSocket: ws,
          } as unknown as Response;

          const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

          const result = await (instance as any).openWebSocket("wss://gateway.discord.gg");
          expect(result.ok).toBe(true);

          emitClose(4014, "disallowed intents");
          await scheduler.wait(0);

          const stored = await instance.ctx.storage.get<GatewayState>(STATE_KEY);
          expect(stored?.wsUrl).toBeNull();
          expect(stored?.sessionId).toBeNull();
          expect(stored?.sequence).toBeNull();

          const alarm = await instance.ctx.storage.getAlarm();
          expect(alarm).toBeNull();

          fetchSpy.mockRestore();
        },
      );
    });

    it("ignores messages from stale websocket instances", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-stale-socket-message-guard");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          const first = makeEventedWebSocket();
          const second = makeEventedWebSocket();

          let upgrades = 0;
          const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
            upgrades += 1;
            return {
              status: 101,
              webSocket: upgrades === 1 ? first.ws : second.ws,
            } as unknown as Response;
          });

          const handlerSpy = vi
            .spyOn(instance as any, "handleGatewayMessage")
            .mockResolvedValue(undefined);

          expect((await (instance as any).openWebSocket("wss://gateway.discord.gg")).ok).toBe(
            true,
          );
          expect((await (instance as any).openWebSocket("wss://gateway.discord.gg")).ok).toBe(
            true,
          );

          first.emitMessage(JSON.stringify({ op: GatewayOpcode.Heartbeat }));
          await scheduler.wait(0);
          expect(handlerSpy).toHaveBeenCalledTimes(0);

          second.emitMessage(JSON.stringify({ op: GatewayOpcode.Heartbeat }));
          await scheduler.wait(0);
          expect(handlerSpy).toHaveBeenCalledTimes(1);

          fetchSpy.mockRestore();
        },
      );
    });

    it("uses webhookSecret header when provided", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-webhook-secret-header");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          await instance.ctx.storage.put(CREDENTIALS_KEY, {
            botToken: "bot-token",
            webhookUrl: "https://example.com/webhook",
            webhookSecret: "secret-token",
          });

          const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(new Response(null, { status: 200 }));

          await (instance as any).forwardEvent("MESSAGE_CREATE", { id: "1" });

          expect(fetchSpy).toHaveBeenCalled();
          const init = fetchSpy.mock.calls[0][1] as RequestInit;
          const headers = init.headers as Record<string, string>;
          expect(headers["x-discord-gateway-token"]).toBe("secret-token");

          fetchSpy.mockRestore();
        },
      );
    });
  });

  // -- types ---------------------------------------------------------------

  describe("types", () => {
    it("GatewayOpcode values match Discord spec", () => {
      expect(GatewayOpcode.Dispatch).toBe(0);
      expect(GatewayOpcode.Heartbeat).toBe(1);
      expect(GatewayOpcode.Identify).toBe(2);
      expect(GatewayOpcode.Resume).toBe(6);
      expect(GatewayOpcode.Reconnect).toBe(7);
      expect(GatewayOpcode.InvalidSession).toBe(9);
      expect(GatewayOpcode.Hello).toBe(10);
      expect(GatewayOpcode.HeartbeatAck).toBe(11);
    });
  });

  // -- getGatewayStub helper -----------------------------------------------

  describe("getGatewayStub", async () => {
    const { getGatewayStub } = await import("../src/index");

    it("returns a stub with default name", () => {
      const stub = getGatewayStub({ namespace: env.DISCORD_GATEWAY });
      expect(stub).toBeDefined();
    });

    it("returns different stubs for different names", () => {
      const stub1 = getGatewayStub({
        namespace: env.DISCORD_GATEWAY,
        name: "agent-1",
      });
      const stub2 = getGatewayStub({
        namespace: env.DISCORD_GATEWAY,
        name: "agent-2",
      });
      expect(stub1.id.toString()).not.toBe(stub2.id.toString());
    });

    it("returns same DO for same name", () => {
      const stub1 = getGatewayStub({
        namespace: env.DISCORD_GATEWAY,
        name: "agent-1",
      });
      const stub2 = getGatewayStub({
        namespace: env.DISCORD_GATEWAY,
        name: "agent-1",
      });
      expect(stub1.id.toString()).toBe(stub2.id.toString());
    });
  });
});
