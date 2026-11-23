import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { acknowledge, ERROR_REPLY_LIFETIME_MS, sendReply, sendStatus, STATUS_REPLY_LIFETIME_MS } from "../dist/replies.js";

/** Records calls and mimics discord.js's deferred/replied bookkeeping. */
class FakeInteraction {
  deferred = false;
  replied = false;
  calls = [];

  constructor(kind, { fail = [] } = {}) {
    this.kind = kind;
    this.fail = new Set(fail);
  }

  isRepliable() { return true; }
  isMessageComponent() { return this.kind === "button"; }

  async #record(name, arg) {
    this.calls.push(arg === undefined ? [name] : [name, arg]);
    if (this.fail.has(name)) throw new Error(`${name} failed`);
  }

  async reply(o) { await this.#record("reply", o.content); this.replied = true; }
  async update(o) { await this.#record("update", o.content); this.replied = true; }
  async editReply(o) { await this.#record("editReply", o.content); this.replied = true; }
  async followUp(o) { await this.#record("followUp", o.content); return { id: "followup-1" }; }
  async deferUpdate() { await this.#record("deferUpdate"); this.deferred = true; }
  async deferReply() { await this.#record("deferReply"); this.deferred = true; }
  async deleteReply(id) { await this.#record("deleteReply", id ?? "@original"); }
}

const names = interaction => interaction.calls.map(call => call[0]);
const deletes = interaction => interaction.calls.filter(call => call[0] === "deleteReply");

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  mock.method(console, "error", () => {});
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

test("button success updates the board text and creates no message", async () => {
  const button = new FakeInteraction("button");
  await sendStatus(button, "Stopped playback.");

  mock.timers.tick(60 * 60_000);
  assert.deepEqual(button.calls, [["update", "Stopped playback."]]);
});

test("slow button action: deferUpdate, then the board is edited in place", async () => {
  const button = new FakeInteraction("button");
  await acknowledge(button);
  await sendStatus(button, "Playing airhorn 🔊");

  mock.timers.tick(60 * 60_000);
  assert.deepEqual(button.calls, [["deferUpdate"], ["editReply", "Playing airhorn 🔊"]]);
});

test("button error after deferUpdate is a separate reply; the board is never edited or deleted", async () => {
  const button = new FakeInteraction("button");
  await acknowledge(button);
  await sendReply(button, "Couldn't connect.");

  assert.deepEqual(button.calls, [["deferUpdate"], ["followUp", "Couldn't connect."]]);

  mock.timers.tick(ERROR_REPLY_LIFETIME_MS - 1);
  assert.deepEqual(deletes(button), []);

  mock.timers.tick(1);
  assert.deepEqual(deletes(button), [["deleteReply", "followup-1"]], "only the follow-up is deleted");
});

test("button error before any acknowledgement is its own reply, deleted after the error lifetime", async () => {
  const button = new FakeInteraction("button");
  await sendReply(button, "You must be in a voice channel!");

  mock.timers.tick(ERROR_REPLY_LIFETIME_MS);
  assert.deepEqual(button.calls, [["reply", "You must be in a voice channel!"], ["deleteReply", "@original"]]);
});

test("a second status on the same button press falls back to a reply", async () => {
  const button = new FakeInteraction("button");
  await sendStatus(button, "first");
  await sendStatus(button, "second");

  assert.deepEqual(names(button), ["update", "followUp"]);
});

test("slash command status is a short-lived ephemeral reply", async () => {
  const command = new FakeInteraction("command");
  await acknowledge(command);
  await sendStatus(command, "Joined voice channel 🔊");

  assert.deepEqual(command.calls, [["deferReply"], ["editReply", "Joined voice channel 🔊"]]);

  mock.timers.tick(STATUS_REPLY_LIFETIME_MS - 1);
  assert.deepEqual(deletes(command), []);

  mock.timers.tick(1);
  assert.deepEqual(deletes(command), [["deleteReply", "@original"]]);
});

test("status replies are readable but brief; errors stay longer", () => {
  assert.ok(STATUS_REPLY_LIFETIME_MS >= 5_000 && STATUS_REPLY_LIFETIME_MS <= 15_000);
  assert.ok(ERROR_REPLY_LIFETIME_MS > STATUS_REPLY_LIFETIME_MS);
  assert.ok(ERROR_REPLY_LIFETIME_MS < 15 * 60_000, "interaction tokens expire after 15 minutes");
});

test("lifetime null keeps the reply", async () => {
  const command = new FakeInteraction("command");
  await sendReply(command, "Available sounds: ...", null);
  await sendReply(command, "...and more", null);

  mock.timers.tick(60 * 60_000);
  assert.deepEqual(names(command), ["reply", "followUp"]);
});

test("failed replies, updates and deletes never throw", async () => {
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  try {
    const expired = new FakeInteraction("button", { fail: ["reply", "update", "deferUpdate", "editReply", "followUp"] });
    await acknowledge(expired);
    await sendStatus(expired, "x");
    await sendReply(expired, "y");

    const undeletable = new FakeInteraction("command", { fail: ["deleteReply"] });
    await sendReply(undeletable, "z");
    mock.timers.tick(ERROR_REPLY_LIFETIME_MS);

    // Let the rejected deleteReply settle.
    mock.timers.reset();
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.deepEqual(names(undeletable), ["reply", "deleteReply"]);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
