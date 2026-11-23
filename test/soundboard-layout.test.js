import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSoundboardLayout,
  clampPage,
  MAX_ACTION_ROWS,
  MAX_BUTTONS_PER_ROW,
  MAX_CUSTOM_ID_LENGTH,
  navCustomId,
  parseNavCustomId,
  SOUNDS_PER_PAGE
} from "../dist/soundboard-layout.js";

const sounds = count => Array.from({ length: count }, (_, i) => `sound ${String(i + 1).padStart(3, "0")}`);

function assertWithinDiscordLimits(layout, context) {
  assert.ok(layout.rows.length >= 1, `${context}: at least the control row`);
  assert.ok(layout.rows.length <= MAX_ACTION_ROWS, `${context}: ${layout.rows.length} rows`);

  const ids = new Set();

  for (const row of layout.rows) {
    assert.ok(row.length >= 1, `${context}: empty row`);
    assert.ok(row.length <= MAX_BUTTONS_PER_ROW, `${context}: ${row.length} buttons in a row`);

    for (const button of row) {
      assert.ok(button.customId.length <= MAX_CUSTOM_ID_LENGTH, `${context}: custom_id ${button.customId.length} chars`);
      assert.ok(!ids.has(button.customId), `${context}: duplicate custom_id ${button.customId}`);
      ids.add(button.customId);
    }
  }
}

const soundNamesOn = layout => layout.rows.flat().filter(b => b.kind === "sound").map(b => b.name);

test("stays within Discord limits for any sound count and page", () => {
  for (const count of [0, 1, 4, 5, 19, 20, 21, 25, 40, 41, 57, 100, 101, 250]) {
    const names = sounds(count);
    const { pageCount } = buildSoundboardLayout(names, 0);

    for (let page = -1; page <= pageCount; page++) {
      assertWithinDiscordLimits(buildSoundboardLayout(names, page), `${count} sounds, page ${page}`);
    }
  }
});

test("every sound appears on exactly one page, in order", () => {
  for (const count of [0, 1, 20, 21, 25, 57, 100, 137]) {
    const names = sounds(count);
    const { pageCount } = buildSoundboardLayout(names, 0);
    const shown = [];

    for (let page = 0; page < pageCount; page++) {
      shown.push(...soundNamesOn(buildSoundboardLayout(names, page)));
    }

    assert.deepEqual(shown, names, `${count} sounds`);
    assert.equal(pageCount, Math.max(1, Math.ceil(count / SOUNDS_PER_PAGE)));
  }
});

test("single page has no paging controls", () => {
  for (const count of [0, 1, 20]) {
    const layout = buildSoundboardLayout(sounds(count), 0);
    const controls = layout.rows.at(-1);

    assert.equal(layout.pageCount, 1);
    assert.deepEqual(controls.map(b => b.customId), ["sb:stop", "sb:leave"]);
  }

  assert.equal(buildSoundboardLayout(sounds(20), 0).rows.length, 5, "20 sounds fill 4 rows + controls");
  assert.equal(buildSoundboardLayout(sounds(0), 0).rows.length, 1, "0 sounds: controls only");
});

test("21 sounds split into a full page and a 1-sound page", () => {
  const first = buildSoundboardLayout(sounds(21), 0);
  const second = buildSoundboardLayout(sounds(21), 1);

  assert.equal(first.pageCount, 2);
  assert.equal(soundNamesOn(first).length, 20);
  assert.deepEqual(soundNamesOn(second), ["sound 021"]);
  assert.equal(second.rows.length, 2);
});

test("control row has Prev / indicator / Next / Stop / Leave with correct targets", () => {
  const names = sounds(57);

  const first = buildSoundboardLayout(names, 0).rows.at(-1);
  assert.deepEqual(first.map(b => b.kind), ["nav", "indicator", "nav", "control", "control"]);
  assert.equal(first[0].disabled, true, "Prev disabled on first page");
  assert.equal(first[1].label, "1 / 3");
  assert.equal(first[2].disabled, false);
  assert.equal(parseNavCustomId(first[2].customId), 1);

  const middle = buildSoundboardLayout(names, 1).rows.at(-1);
  assert.equal(parseNavCustomId(middle[0].customId), 0);
  assert.equal(parseNavCustomId(middle[2].customId), 2);
  assert.equal(middle[0].disabled, false);
  assert.equal(middle[2].disabled, false);

  const last = buildSoundboardLayout(names, 2).rows.at(-1);
  assert.equal(last[1].label, "3 / 3");
  assert.equal(last[2].disabled, true, "Next disabled on last page");
});

test("out-of-range pages are clamped", () => {
  // e.g. a "Next" to page 5 pressed after sounds were removed.
  assert.equal(buildSoundboardLayout(sounds(57), 5).page, 2);
  assert.equal(buildSoundboardLayout(sounds(57), -3).page, 0);
  assert.equal(buildSoundboardLayout(sounds(57), Number.NaN).page, 0);
  assert.equal(buildSoundboardLayout(sounds(0), 4).page, 0);

  assert.equal(clampPage(7, 3), 2);
  assert.equal(clampPage(1.9, 3), 1);
  assert.equal(clampPage(Infinity, 3), 0);
});

test("long names get a button with a short custom_id and duplicates are dropped", () => {
  const longest = "x".repeat(MAX_CUSTOM_ID_LENGTH - "sb:play:".length);
  const tooLong = "y".repeat(MAX_CUSTOM_ID_LENGTH);
  const layout = buildSoundboardLayout([longest, tooLong, "a", "a", "b"], 0);

  assert.deepEqual(soundNamesOn(layout), [longest, tooLong, "a", "b"]);
  assert.equal(layout.totalSounds, 4);
  assertWithinDiscordLimits(layout, "long names");

  const [longestButton, tooLongButton] = layout.rows[0];
  assert.equal(longestButton.customId, `sb:play:${longest}`);
  assert.match(tooLongButton.customId, /^sb:playk:/);

  const longNames = Array.from({ length: 60 }, (_, i) => `${String(i).padStart(2, "0")}${"z".repeat(90)}`);
  for (let page = 0; page < 3; page++) {
    assertWithinDiscordLimits(buildSoundboardLayout(longNames, page), `long names page ${page}`);
  }
});

test("nav custom IDs round-trip and reject anything else", () => {
  assert.equal(parseNavCustomId(navCustomId("next", 3)), 3);
  assert.equal(parseNavCustomId(navCustomId("prev", 0)), 0);

  for (const id of ["sb:nav:page", "sb:nav:next:", "sb:nav:next:-1", "sb:nav:next:1.5", "sb:nav:up:1", "sb:play:next", "sb:stop"]) {
    assert.equal(parseNavCustomId(id), null, id);
  }
});
