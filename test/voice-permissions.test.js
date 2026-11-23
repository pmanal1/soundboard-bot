import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVoiceControlContext,
  checkVoiceControl,
  describeVoiceControlRefusal
} from "../dist/voice-permissions.js";

const ctx = overrides => ({
  botChannelId: "music",
  memberChannelId: "music",
  otherListeners: 2,
  canBypass: false,
  ...overrides
});

test("allows anyone when the bot isn't connected", () => {
  assert.equal(checkVoiceControl(ctx({ botChannelId: null, memberChannelId: "general", otherListeners: 0 })), "allowed");
  assert.equal(checkVoiceControl(ctx({ botChannelId: null, memberChannelId: null, otherListeners: 0 })), "allowed");
});

test("allows members in the bot's channel", () => {
  assert.equal(checkVoiceControl(ctx()), "allowed");
});

test("allows summoning or stopping the bot when it's alone", () => {
  assert.equal(checkVoiceControl(ctx({ memberChannelId: "general", otherListeners: 0 })), "allowed");
  assert.equal(checkVoiceControl(ctx({ memberChannelId: null, otherListeners: 0 })), "allowed");
});

test("refuses members in another channel while others are listening", () => {
  assert.equal(checkVoiceControl(ctx({ memberChannelId: "general" })), "refused");
  assert.equal(checkVoiceControl(ctx({ memberChannelId: "general", otherListeners: 1 })), "refused");
});

test("refuses members not in voice while others are listening", () => {
  assert.equal(checkVoiceControl(ctx({ memberChannelId: null })), "refused");
});

test("Move Members bypasses the check", () => {
  assert.equal(checkVoiceControl(ctx({ memberChannelId: "general", canBypass: true })), "bypass");
  assert.equal(checkVoiceControl(ctx({ memberChannelId: null, canBypass: true })), "bypass");
  // Not reported as a bypass when the check would have passed anyway.
  assert.equal(checkVoiceControl(ctx({ canBypass: true })), "allowed");
});

const member = (id, channelId) => ({ id, voice: { channelId } });
const channel = (id, members) => ({
  id,
  members: new Map(members.map(([memberId, bot]) => [memberId, { user: { bot } }]))
});

test("buildVoiceControlContext ignores bots and the invoker when counting listeners", () => {
  const botChannel = channel("music", [["bot", true], ["otherBot", true], ["alice", false], ["bob", false]]);

  assert.deepEqual(buildVoiceControlContext(member("alice", "music"), botChannel, false), {
    botChannelId: "music",
    memberChannelId: "music",
    otherListeners: 1,
    canBypass: false
  });

  assert.equal(buildVoiceControlContext(member("carol", "general"), botChannel, true).otherListeners, 2);
});

test("buildVoiceControlContext treats a missing bot channel as not connected", () => {
  const result = buildVoiceControlContext(member("alice", null), null, false);

  assert.equal(result.botChannelId, null);
  assert.equal(result.otherListeners, 0);
  assert.equal(checkVoiceControl(result), "allowed");
});

test("bot channel with only other bots counts as empty", () => {
  const botChannel = channel("music", [["bot", true], ["musicBot", true]]);

  assert.equal(checkVoiceControl(buildVoiceControlContext(member("alice", "general"), botChannel, false)), "allowed");
});

test("refusal messages mention the bot's channel", () => {
  for (const action of ["summon", "stop", "leave"]) {
    assert.match(describeVoiceControlRefusal(action, "123"), /<#123>/);
  }
});
