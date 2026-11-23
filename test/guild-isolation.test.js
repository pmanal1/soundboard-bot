import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { AudioPlayerStatus, VoiceConnectionStatus } from "@discordjs/voice";
import { connectTo, getActiveGuildIds, getPlayer, leaveGuild, setVoiceBackend, stopGuildPlayback } from "../dist/voice.js";
import { createFakeVoiceBackend, fakeVoiceChannel } from "./helpers/fake-voice.js";

const GUILD_A = "guild-a";
const GUILD_B = "guild-b";

let fake;
let restoreBackend;

beforeEach(() => {
  fake = createFakeVoiceBackend();
  restoreBackend = setVoiceBackend(fake);
});

afterEach(() => {
  for (const guildId of getActiveGuildIds()) leaveGuild(guildId);
  restoreBackend();
});

/** Connects to a guild and starts "playing" a sound there. */
async function joinAndPlay(guildId, channelId = `${guildId}-voice`) {
  const result = await connectTo(fakeVoiceChannel(guildId, channelId), 1_000);
  assert.equal(result.ok, true);
  result.player.play({ sound: `${guildId}.mp3` });
  return result.player;
}

test("each guild gets its own connection and player", async () => {
  const playerA = await joinAndPlay(GUILD_A);
  const playerB = await joinAndPlay(GUILD_B);

  assert.notEqual(playerA, playerB);
  assert.notEqual(fake.connections.get(GUILD_A), fake.connections.get(GUILD_B));
  assert.equal(fake.connections.get(GUILD_A).subscribedPlayer, playerA);
  assert.equal(fake.connections.get(GUILD_B).subscribedPlayer, playerB);
  assert.equal(getPlayer(GUILD_A), playerA);
  assert.equal(getPlayer(GUILD_B), playerB);
});

test("joining guild B doesn't drop guild A", async () => {
  await joinAndPlay(GUILD_A);
  const connA = fake.connections.get(GUILD_A);

  await joinAndPlay(GUILD_B);

  assert.equal(connA.state.status, VoiceConnectionStatus.Ready);
  assert.equal(connA.destroyCalls, 0);
  assert.equal(getPlayer(GUILD_A).state.status, AudioPlayerStatus.Playing);
});

test("stopping guild A leaves guild B playing", async () => {
  const playerA = await joinAndPlay(GUILD_A);
  const playerB = await joinAndPlay(GUILD_B);

  assert.equal(stopGuildPlayback(GUILD_A), true);

  assert.equal(playerA.state.status, AudioPlayerStatus.Idle);
  assert.equal(playerB.state.status, AudioPlayerStatus.Playing);
  assert.deepEqual(playerB.nowPlaying, { sound: `${GUILD_B}.mp3` });
});

test("leaving guild A destroys only A's connection and player", async () => {
  const playerA = await joinAndPlay(GUILD_A);
  const playerB = await joinAndPlay(GUILD_B);
  const connA = fake.connections.get(GUILD_A);
  const connB = fake.connections.get(GUILD_B);

  assert.equal(leaveGuild(GUILD_A), true);

  assert.equal(connA.state.status, VoiceConnectionStatus.Destroyed);
  assert.equal(playerA.state.status, AudioPlayerStatus.Idle);
  assert.equal(getPlayer(GUILD_A), undefined);
  assert.deepEqual(getActiveGuildIds(), [GUILD_B]);

  assert.equal(connB.state.status, VoiceConnectionStatus.Ready);
  assert.equal(connB.subscribedPlayer, playerB);
  assert.equal(playerB.state.status, AudioPlayerStatus.Playing);
});

test("a connection destroyed elsewhere (kick, failed reconnect) only cleans up its own guild", async () => {
  const playerA = await joinAndPlay(GUILD_A);
  const playerB = await joinAndPlay(GUILD_B);

  fake.connections.get(GUILD_A).destroy();

  assert.equal(getPlayer(GUILD_A), undefined);
  assert.equal(playerA.state.status, AudioPlayerStatus.Idle);
  assert.equal(getPlayer(GUILD_B), playerB);
  assert.equal(playerB.state.status, AudioPlayerStatus.Playing);
});

test("released state leaves no stale listeners or subscriptions behind", async () => {
  const playerA = await joinAndPlay(GUILD_A);
  const connA = fake.connections.get(GUILD_A);

  leaveGuild(GUILD_A);

  assert.equal(playerA.listenerCount("error"), 0);
  assert.equal(playerA.listenerCount("stateChange"), 0);
  assert.equal(connA.subscribedPlayer, null);
  assert.deepEqual(getActiveGuildIds(), []);
});

test("rejoining guild A after leaving gets a fresh player and doesn't touch B", async () => {
  const oldPlayerA = await joinAndPlay(GUILD_A);
  const playerB = await joinAndPlay(GUILD_B);

  leaveGuild(GUILD_A);
  const newPlayerA = await joinAndPlay(GUILD_A);

  assert.notEqual(newPlayerA, oldPlayerA);
  assert.equal(getPlayer(GUILD_B), playerB);
  assert.equal(fake.players.length, 3);
});

test("repeat joins in the same guild reuse its connection and player", async () => {
  const first = await joinAndPlay(GUILD_A, "channel-1");
  const second = await joinAndPlay(GUILD_A, "channel-2");

  assert.equal(first, second);
  assert.equal(fake.players.length, 1);
  assert.equal(fake.connections.get(GUILD_A).joinConfig.channelId, "channel-2");
});

test("stop/leave in a guild the bot isn't in is a no-op for the others", async () => {
  const playerB = await joinAndPlay(GUILD_B);

  assert.equal(stopGuildPlayback(GUILD_A), false);
  assert.equal(leaveGuild(GUILD_A), false);

  assert.equal(playerB.state.status, AudioPlayerStatus.Playing);
  assert.equal(fake.connections.get(GUILD_B).state.status, VoiceConnectionStatus.Ready);
});
