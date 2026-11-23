// Before/after demo for button labels, custom IDs and /list output with awkward file names.
// Run: npm run build && node scripts/sound-text-demo.js
import { chunkList, formatLabel, playCustomId, MAX_MESSAGE_LENGTH } from "../dist/sound-text.js";
import { isValidSoundName, listSoundNames, resolveSound, stripSoundExtension } from "../dist/sounds.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const files = [
  "airhorn.mp3",
  "a.mp3.remix.mp3",
  "x.mp3.mp3",
  "Loud.MP3",
  ".mp3",
  "the extremely long name of a sound clip that somebody downloaded from a video site.mp3",
  "😂".repeat(45) + ".mp3",
  "👨‍👩‍👧‍👦 family reunion 👨‍👩‍👧‍👦 but the name keeps going on and on and on and on and on.mp3",
  "x".repeat(95) + ".mp3"
];

// --- Old behaviour (main before this change) ---------------------------------------------
const oldName = file => file.slice(0, -".mp3".length);           // listSoundNames
const oldLabel = name => name.length > 80 ? `${name.slice(0, 79)}…` : name;
const oldCustomId = name => `sb:play:${name}`;                  // names > 92 chars were dropped
const oldReply = msg => msg.length > 2000 ? `${msg.slice(0, 1999)}…` : msg;

const show = text => JSON.stringify(text);
const wellFormed = text => (text.isWellFormed() ? "" : "  ⚠ broken character");

console.log("=== Button labels and custom IDs ===\n");

for (const file of files) {
  const before = oldName(file);
  const after = stripSoundExtension(file);

  console.log(`file   ${show(file)}`);

  if (!isValidSoundName(before)) {
    console.log(`  before: name ${show(before)} → hidden (invalid)`);
  } else {
    const id = oldCustomId(before);
    const status = id.length > 100 ? `dropped from soundboard (custom_id ${id.length} > 100)` : `custom_id ${id.length} chars`;
    console.log(`  before: label ${show(oldLabel(before))} (${oldLabel(before).length})${wellFormed(oldLabel(before))}; ${status}`);
  }

  if (!isValidSoundName(after)) {
    console.log(`  after:  name ${show(after)} → hidden (invalid)\n`);
  } else {
    const label = formatLabel(after);
    const id = playCustomId(after);
    console.log(`  after:  label ${show(label)} (${label.length})${wellFormed(label)}; custom_id ${show(id)} (${id.length})\n`);
  }
}

console.log("=== /list with 500 sounds ===\n");

const names = Array.from({ length: 500 }, (_, i) => `sound clip number ${String(i + 1).padStart(3, "0")}`);
const bullets = names.map(name => `• ${name}`);

const before = oldReply(`Available sounds:\n\n${bullets.join("\n")}`);
console.log(`before: 1 message, ${before.length} chars, ends mid-line with: ${show(before.slice(-30))}`);

const chunks = chunkList(bullets, {
  maxLength: MAX_MESSAGE_LENGTH,
  maxChunks: 3,
  header: `Available sounds (${names.length}):\n`,
  moreNote: count => `…and ${count} more. Use /play with the exact name to play one.`
});

console.log(`after:  ${chunks.length} messages, lengths ${chunks.map(c => c.length).join(", ")} (limit ${MAX_MESSAGE_LENGTH})`);
console.log(`        first lines: ${show(chunks[0].split("\n").slice(0, 3).join("\n"))}`);
console.log(`        last lines:  ${show(chunks.at(-1).split("\n").slice(-2).join("\n"))}`);

console.log("\n=== /play input and folder listing ===\n");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sound-text-demo-"));

try {
  for (const file of ["airhorn.mp3", "a.mp3.remix.mp3", "x.mp3", "x.mp3.mp3", "dup.mp3", "dup.MP3", ".mp3"]) {
    fs.writeFileSync(path.join(dir, file), file);
  }

  console.log(`folder: ${fs.readdirSync(dir).sort().join(", ")}`);
  console.log(`/list names: ${listSoundNames(dir).join(", ")}  (sorted, "dup" once, ".mp3" hidden)\n`);

  for (const input of ["airhorn", "airhorn.mp3", "a.mp3.remix.mp3", "x.mp3", "a.mp3", ".mp3"]) {
    // Before: only the exact name matched.
    const before = isValidSoundName(input) && fs.readdirSync(dir).includes(`${input}.mp3`) ? `plays ${input}.mp3` : "Sound not found";
    const result = await resolveSound(dir, input);
    const after = result.ok ? `plays ${path.basename(result.filePath)} → "Playing ${result.name} 🔊"` : result.reason;
    console.log(`/play ${show(input).padEnd(18)} before: ${before.padEnd(22)} after: ${after}`);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
