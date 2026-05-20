# Changelog

## 0.1.3

### Fixed

- **Breaking-in-practice:** the public RPC method is now `start()` instead of `connect()`. `DurableObjectStub` extends `Fetcher`, and the Workers RPC dispatcher resolves `Fetcher`'s built-in `connect(SocketAddress)` before any user-defined `connect` on the DO class. Calling `stub.connect(credentials)` therefore never reached `DiscordGatewayDO.connect` — it routed to the TCP-socket builtin and threw `TypeError: The value cannot be converted because it is not an integer.` This means the 0.1.x README sample never worked in production for stub callers.

### Migration

Replace `stub.connect(...)` with `stub.start(...)`:

```diff
- await gateway.connect({ botToken, webhookUrl });
+ await gateway.start({ botToken, webhookUrl });
```

`status()` and `disconnect()` are unchanged.

For backward compatibility, `DiscordGatewayDO.connect()` is kept as a deprecated in-class alias that delegates to `start()`. It is reachable from `runInDurableObject` callers and from subclasses that call `super.connect(...)`, but **not** through a stub. It will be removed in 0.2.

## 0.1.2

- Hardened gateway reconnect and protocol handling.

## 0.1.1

- Added README badges, version bump.

## 0.1.0

- Initial release: Discord Gateway DO for Cloudflare Workers.
