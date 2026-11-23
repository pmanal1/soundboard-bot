import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chunkList,
  deleteLater,
  findSoundByKey,
  formatLabel,
  MAX_BUTTON_LABEL_LENGTH,
  MAX_CUSTOM_ID_LENGTH,
  MAX_MESSAGE_LENGTH,
  parsePlayCustomId,
  playCustomId,
  soundKey,
  truncate
} from "../dist/sound-text.js";
import { isValidSoundName, MAX_SOUND_NAME_LENGTH, stripSoundExtension } from "../dist/sounds.js";

const graphemes = text => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(s => s.segment);

test("short labels are unchanged", () => {
  assert.equal(formatLabel("airhorn"), "airhorn");
  assert.equal(formatLabel("x".repeat(80)), "x".repeat(80));
});

test("80+ character names are cut to 80 with an ellipsis", () => {
  const name = "a really long sound name that keeps going and going well past what Discord allows for labels";
  assert.ok(name.length > 80);

  const label = formatLabel(name);
  assert.equal(label.length <= MAX_BUTTON_LABEL_LENGTH, true);
  assert.ok(label.endsWith("…"));
  assert.ok(name.startsWith(label.slice(0, -1)));
  // No dangling space before the ellipsis.
  assert.ok(!/\s…$/.test(label));

  assert.equal(formatLabel("x".repeat(81)), `${"x".repeat(79)}…`);
});

test("truncation never splits emoji, flags or combining characters", () => {
  const cases = [
    "😂".repeat(60),                      // surrogate pairs (2 code units each)
    "👨‍👩‍👧‍👦".repeat(10),                  // ZWJ family, 11 code units each
    "🇯🇵🇺🇸".repeat(30),                    // regional-indicator flags
    "é".repeat(60),                 // e + combining acute
    `${"x".repeat(78)}😂😂`               // emoji straddling the cut point
  ];

  for (const name of cases) {
    const label = formatLabel(name);
    assert.ok(label.length <= MAX_BUTTON_LABEL_LENGTH, `${label.length} > 80`);
    assert.ok(label.endsWith("…"));

    const kept = graphemes(label.slice(0, -1));
    const original = graphemes(name);
    assert.deepEqual(kept, original.slice(0, kept.length), JSON.stringify(name));
    // No lone surrogates.
    assert.ok(label.isWellFormed());
  }

  assert.equal(formatLabel(`${"x".repeat(78)}😂😂`), `${"x".repeat(78)}…`);
});

test("empty or blank labels get a placeholder", () => {
  assert.equal(formatLabel(""), "(unnamed)");
  assert.equal(formatLabel("   "), "(unnamed)");
});

test("truncate handles tiny limits", () => {
  assert.equal(truncate("hello", 0), "");
  assert.equal(truncate("hello", 1), "…");
  assert.equal(truncate("hello", 5), "hello");
  assert.equal(truncate("hello!", 5), "hell…");
});

test("only a single trailing .mp3 is stripped", () => {
  assert.equal(stripSoundExtension("airhorn.mp3"), "airhorn");
  assert.equal(stripSoundExtension("Loud.MP3"), "Loud");
  assert.equal(stripSoundExtension("a.mp3.remix.mp3"), "a.mp3.remix");
  assert.equal(stripSoundExtension("x.mp3.mp3"), "x.mp3");
  assert.equal(stripSoundExtension("v1.2.final.mp3"), "v1.2.final");
  assert.equal(stripSoundExtension("a.mp3.remix"), "a.mp3.remix");
  assert.equal(stripSoundExtension("mp3"), "mp3");
  assert.equal(stripSoundExtension("🎺.mp3"), "🎺");
});

test("a name that is empty after stripping is not a valid sound", () => {
  assert.equal(stripSoundExtension(".mp3"), "");
  assert.equal(isValidSoundName(stripSoundExtension(".mp3")), false);
  assert.equal(isValidSoundName(stripSoundExtension(" .mp3")), false);
});

test("custom IDs always fit and round-trip", () => {
  const names = [
    "airhorn",
    "🫵😂",
    "a.mp3.remix",
    "x".repeat(MAX_CUSTOM_ID_LENGTH - "sb:play:".length),     // exactly fits
    "x".repeat(MAX_CUSTOM_ID_LENGTH - "sb:play:".length + 1), // one too long
    "y".repeat(MAX_SOUND_NAME_LENGTH),
    "😂".repeat(50)                                            // 50 graphemes, 100 code units
  ];

  for (const name of names) {
    const id = playCustomId(name);
    assert.ok(id.length <= MAX_CUSTOM_ID_LENGTH, `${id.length} > 100 for ${JSON.stringify(name)}`);

    const target = parsePlayCustomId(id);
    const resolved = target.kind === "name" ? target.name : findSoundByKey(names, target.key);
    assert.equal(resolved, name);
  }

  assert.equal(playCustomId("airhorn"), "sb:play:airhorn", "short names stay readable");
  assert.match(playCustomId("y".repeat(100)), /^sb:playk:[A-Za-z0-9_-]{22}$/);
});

test("custom IDs are unique for distinct long names", () => {
  const base = "z".repeat(95);
  const ids = new Set(Array.from({ length: 500 }, (_, i) => playCustomId(`${base}${i}`)));
  assert.equal(ids.size, 500);
});

test("parsing play custom IDs", () => {
  assert.deepEqual(parsePlayCustomId("sb:play:a:b"), { kind: "name", name: "a:b" });
  assert.deepEqual(parsePlayCustomId("sb:playk:abc"), { kind: "key", key: "abc" });
  assert.equal(parsePlayCustomId("sb:stop"), null);
  assert.equal(parsePlayCustomId("sb:nav:next:1"), null);
});

test("unknown or stale keys don't resolve", () => {
  assert.equal(findSoundByKey(["airhorn"], "nope"), null);
  assert.equal(findSoundByKey([], soundKey("airhorn")), null);
  assert.equal(findSoundByKey(["airhorn", "airhorn"], soundKey("airhorn")), null, "ambiguous");
  assert.equal(soundKey("airhorn"), soundKey("airhorn"), "stable");
});

const sounds500 = Array.from({ length: 500 }, (_, i) => `sound number ${i} with a reasonably long descriptive name`);

test("a 500-sound list is split into messages under 2000 characters", () => {
  const lines = sounds500.map(n => `• ${n}`);
  const chunks = chunkList(lines, { header: "Available sounds (500):\n" });

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= MAX_MESSAGE_LENGTH, `${chunk.length}`);

  // Every sound appears exactly once, in order, and no line is split.
  const shown = chunks.join("\n").split("\n").filter(l => l.startsWith("• "));
  assert.deepEqual(shown, lines);
  assert.ok(chunks[0].startsWith("Available sounds (500):\n\n• sound number 0 "));
});

test("a 500-sound list capped to a few messages ends with '…and N more'", () => {
  const lines = sounds500.map(n => `• ${n}`);
  const chunks = chunkList(lines, { maxChunks: 3, header: "Available sounds (500):\n" });

  assert.equal(chunks.length, 3);
  for (const chunk of chunks) assert.ok(chunk.length <= MAX_MESSAGE_LENGTH);

  const last = chunks.at(-1).split("\n").at(-1);
  const match = /^…and (\d+) more$/.exec(last);
  assert.ok(match, last);

  const shown = chunks.join("\n").split("\n").filter(l => l.startsWith("• "));
  assert.equal(shown.length + Number(match[1]), 500, "shown + hidden = total");
  assert.deepEqual(shown, lines.slice(0, shown.length));
});

test("a single 4096-limited block (embed size) works too", () => {
  const chunks = chunkList(sounds500, { maxLength: 4096, maxChunks: 1 });
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].length <= 4096);
  assert.match(chunks[0], /\n…and \d+ more$/);
});

test("chunkList edge cases", () => {
  assert.deepEqual(chunkList([]), []);
  assert.deepEqual(chunkList([], { header: "Sounds:" }), ["Sounds:"]);
  assert.deepEqual(chunkList(["a", "b"]), ["a\nb"]);

  // An over-long line is truncated instead of overflowing.
  const [chunk] = chunkList(["x".repeat(5000)]);
  assert.equal(chunk.length, MAX_MESSAGE_LENGTH);
  assert.ok(chunk.endsWith("…"));

  // The note always fits, even when it has to replace items.
  const tight = chunkList(["aaaa", "bbbb", "cccc", "dddd", "eeee"], { maxLength: 16, maxChunks: 1 });
  assert.deepEqual(tight, ["aaaa\n…and 4 more"]);

  // Custom note text.
  assert.deepEqual(chunkList(["a", "b", "c"], { maxLength: 4, maxChunks: 1, moreNote: n => `+${n}` }), ["a\n+2"]);
});

test("deleteLater swallows sync throws and rejections", async () => {
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  try {
    const errors = [];
    let calls = 0;

    deleteLater(() => { calls++; throw new Error("sync"); }, 0, e => errors.push(e.message));
    deleteLater(() => { calls++; return Promise.reject(new Error("async")); }, 0, e => errors.push(e.message));
    deleteLater(() => { calls++; throw new Error("no handler"); }, 0);
    deleteLater(() => { calls++; throw new Error("bad handler"); }, 0, () => { throw new Error("handler"); });
    deleteLater(() => { calls++; return Promise.resolve(); }, 0);

    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(calls, 5);
    assert.deepEqual(errors.sort(), ["async", "sync"]);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("deleteLater doesn't keep the process alive", () => {
  const timer = deleteLater(() => {}, 60_000);
  assert.equal(timer.hasRef(), false);
  clearTimeout(timer);
});
