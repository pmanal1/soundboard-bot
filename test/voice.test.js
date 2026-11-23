import { test } from "node:test";
import assert from "node:assert/strict";
import { VoiceConnectionDisconnectReason, VoiceConnectionStatus } from "@discordjs/voice";
import { destroyConnection, trackConnection, waitUntilReady } from "../dist/voice.js";
import { FakeConnection } from "./helpers/fake-voice.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test("destroyConnection is safe to call twice", () => {
  const conn = new FakeConnection();

  assert.equal(destroyConnection(conn), true);
  assert.equal(destroyConnection(conn), false);
  assert.equal(conn.destroyCalls, 1);
});

test("destroyConnection swallows the throw when another path destroyed it first", () => {
  const conn = new FakeConnection();
  conn.destroy = function () {
    this.state = { status: VoiceConnectionStatus.Destroyed };
    throw new Error("Cannot destroy VoiceConnection - it has already been destroyed");
  };

  assert.doesNotThrow(() => destroyConnection(conn));
});

test("waitUntilReady resolves once the connection is Ready", async () => {
  const conn = new FakeConnection();
  setTimeout(() => conn.setState({ status: VoiceConnectionStatus.Ready }), 10);

  assert.deepEqual(await waitUntilReady(conn, "g", 1_000), { ok: true });
});

test("waitUntilReady times out and destroys a half-connected connection", async () => {
  const conn = new FakeConnection();

  assert.deepEqual(await waitUntilReady(conn, "g", 30), { ok: false, reason: "timeout" });
  assert.equal(conn.state.status, VoiceConnectionStatus.Destroyed);
});

test("waitUntilReady stops waiting as soon as the connection is destroyed", async () => {
  const conn = new FakeConnection();
  setTimeout(() => destroyConnection(conn), 10);

  const started = Date.now();
  assert.deepEqual(await waitUntilReady(conn, "g", 5_000), { ok: false, reason: "destroyed" });
  assert.ok(Date.now() - started < 1_000);
  assert.equal(conn.destroyCalls, 1);
});

test("kicked from voice (4014, no reconnect): cleans up once", async () => {
  const conn = new FakeConnection();
  let destroyedEvents = 0;
  trackConnection(conn, "g", { onDestroyed: () => destroyedEvents++, reconnectGraceMs: 20 });

  conn.setState({ status: VoiceConnectionStatus.Disconnected, reason: VoiceConnectionDisconnectReason.WebSocketClose, closeCode: 4014 });
  await sleep(60);

  assert.equal(conn.state.status, VoiceConnectionStatus.Destroyed);
  assert.equal(destroyedEvents, 1);
});

test("moved to another channel (4014, then reconnecting): keeps the connection", async () => {
  const conn = new FakeConnection();
  trackConnection(conn, "g", { reconnectGraceMs: 50 });

  conn.setState({ status: VoiceConnectionStatus.Disconnected, reason: VoiceConnectionDisconnectReason.WebSocketClose, closeCode: 4014 });
  conn.setState({ status: VoiceConnectionStatus.Signalling });
  conn.setState({ status: VoiceConnectionStatus.Ready });
  await sleep(80);

  assert.equal(conn.state.status, VoiceConnectionStatus.Ready);
  assert.equal(conn.destroyCalls, 0);
});

test("network drop: rejoins with backoff, then gives up and cleans up", async () => {
  const conn = new FakeConnection();
  trackConnection(conn, "g", { rejoinBackoffMs: 5, maxRejoinAttempts: 2 });
  const drop = () => conn.setState({ status: VoiceConnectionStatus.Disconnected, reason: VoiceConnectionDisconnectReason.EndpointRemoved });

  drop();
  await sleep(30);
  assert.equal(conn.rejoinCalls, 1);

  drop();
  await sleep(40);
  assert.equal(conn.rejoinCalls, 2);

  drop();
  await sleep(10);
  assert.equal(conn.state.status, VoiceConnectionStatus.Destroyed);
  assert.equal(conn.destroyCalls, 1);
});

test("a failed rejoin (Disconnected -> Disconnected) is retried, then cleaned up", async () => {
  const conn = new FakeConnection();
  // Like @discordjs/voice when the gateway adapter can't send: stays Disconnected.
  conn.rejoin = function () {
    this.rejoinAttempts++;
    this.rejoinCalls++;
    this.setState({ ...this.state, status: VoiceConnectionStatus.Disconnected, reason: VoiceConnectionDisconnectReason.AdapterUnavailable });
    return false;
  };
  conn.rejoinCalls = 0;
  trackConnection(conn, "g", { rejoinBackoffMs: 2, maxRejoinAttempts: 3 });

  conn.setState({ status: VoiceConnectionStatus.Disconnected, reason: VoiceConnectionDisconnectReason.AdapterUnavailable });
  await sleep(80);

  assert.equal(conn.rejoinCalls, 3);
  assert.equal(conn.state.status, VoiceConnectionStatus.Destroyed);
  assert.equal(conn.destroyCalls, 1);
});

test("a /leave during rejoin backoff doesn't rejoin or double-destroy", async () => {
  const conn = new FakeConnection();
  trackConnection(conn, "g", { rejoinBackoffMs: 30 });

  conn.setState({ status: VoiceConnectionStatus.Disconnected, reason: VoiceConnectionDisconnectReason.AdapterUnavailable });
  destroyConnection(conn);
  await sleep(60);

  assert.equal(conn.rejoinCalls, 0);
  assert.equal(conn.destroyCalls, 1);
});

test("listeners are attached only once per connection", () => {
  const conn = new FakeConnection();
  trackConnection(conn, "g");
  trackConnection(conn, "g");

  assert.equal(conn.listenerCount("stateChange"), 1);
  assert.equal(conn.listenerCount("error"), 1);
});
