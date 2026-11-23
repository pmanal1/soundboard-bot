import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isValidSoundName, listSoundNames, resolveSound } from "../dist/sounds.js";

let root;
let soundsDir;
let extDir;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "soundboard-test-"));
  soundsDir = path.join(root, "sounds");
  fs.mkdirSync(soundsDir);
  fs.writeFileSync(path.join(soundsDir, "airhorn.mp3"), "x");
  fs.writeFileSync(path.join(soundsDir, "Loud.MP3"), "x");
  fs.writeFileSync(path.join(soundsDir, "🫵😂.mp3"), "x");
  fs.writeFileSync(path.join(soundsDir, "notes.txt"), "x");
  fs.mkdirSync(path.join(soundsDir, "folder.mp3"));
  fs.writeFileSync(path.join(root, "secret.mp3"), "top secret");
  fs.symlinkSync(path.join(root, "secret.mp3"), path.join(soundsDir, "escape.mp3"));
  fs.symlinkSync(path.join(soundsDir, "airhorn.mp3"), path.join(soundsDir, "alias.mp3"));

  // Names that are awkward to strip the extension from.
  extDir = path.join(root, "ext");
  fs.mkdirSync(extDir);
  for (const file of ["a.mp3.remix.mp3", "x.mp3.mp3", "x.mp3", ".mp3", "dup.mp3", "dup.MP3", "v1.2.final.mp3"]) {
    fs.writeFileSync(path.join(extDir, file), file);
  }
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test("rejects names that could leave the sounds folder or are malformed", () => {
  for (const name of ["", ".", "..", "../secret", "..\\secret", "a/b", "/etc/passwd", "nul\0byte", "tab\tname", " padded", "x".repeat(101)]) {
    assert.equal(isValidSoundName(name), false, JSON.stringify(name));
  }

  for (const name of ["airhorn", "BANG! BANG!", "🫵😂", "oh BROTHER", "...dots"]) {
    assert.equal(isValidSoundName(name), true, JSON.stringify(name));
  }
});

test("lists only mp3 files", () => {
  assert.deepEqual(listSoundNames(soundsDir).sort(), ["airhorn", "alias", "escape", "Loud", "🫵😂"].sort());
  assert.equal(listSoundNames(path.join(root, "missing")), null);
});

test("resolves sounds that are inside the folder", async () => {
  const result = await resolveSound(soundsDir, "airhorn");
  assert.equal(result.ok, true);
  assert.equal(result.filePath, fs.realpathSync(path.join(soundsDir, "airhorn.mp3")));

  assert.equal((await resolveSound(soundsDir, "🫵😂")).ok, true);
  assert.equal((await resolveSound(soundsDir, "Loud")).ok, true, "upper-case extension");
  assert.equal((await resolveSound(soundsDir, "alias")).ok, true, "symlink that stays inside");
});

test("rejects traversal, symlink escapes, missing files and directories", async () => {
  assert.deepEqual(await resolveSound(soundsDir, "../secret"), { ok: false, reason: "invalid-name" });
  assert.deepEqual(await resolveSound(soundsDir, path.join(root, "secret")), { ok: false, reason: "invalid-name" });
  assert.deepEqual(await resolveSound(soundsDir, "escape"), { ok: false, reason: "outside-folder" });
  assert.deepEqual(await resolveSound(soundsDir, "nope"), { ok: false, reason: "not-found" });
  assert.deepEqual(await resolveSound(soundsDir, "folder"), { ok: false, reason: "not-found" });
  assert.deepEqual(await resolveSound(soundsDir, "AIRHORN"), { ok: false, reason: "not-found" });
  assert.deepEqual(await resolveSound(path.join(root, "missing"), "airhorn"), { ok: false, reason: "no-folder" });
});

test("rejects unreadable files", { skip: process.getuid?.() === 0 && "root can read anything" }, async () => {
  const file = path.join(soundsDir, "locked.mp3");
  fs.writeFileSync(file, "x");
  fs.chmodSync(file, 0o000);

  try {
    assert.deepEqual(await resolveSound(soundsDir, "locked"), { ok: false, reason: "unreadable" });
  } finally {
    fs.rmSync(file);
  }
});

test("strips only the trailing extension, hides empty names and de-duplicates", () => {
  assert.deepEqual(listSoundNames(extDir), ["a.mp3.remix", "dup", "v1.2.final", "x", "x.mp3"]);
});

test("accepts a typed .mp3 extension, but an exact name wins", async () => {
  const play = async name => {
    const result = await resolveSound(extDir, name);
    return result.ok ? [result.name, fs.readFileSync(result.filePath, "utf8")] : result.reason;
  };

  assert.deepEqual(await play("a.mp3.remix"), ["a.mp3.remix", "a.mp3.remix.mp3"]);
  assert.deepEqual(await play("a.mp3.remix.mp3"), ["a.mp3.remix", "a.mp3.remix.mp3"]);
  assert.deepEqual(await play("x"), ["x", "x.mp3"]);
  assert.deepEqual(await play("x.mp3"), ["x.mp3", "x.mp3.mp3"], "exact name beats stripping");
  assert.deepEqual(await play("x.MP3"), ["x", "x.mp3"]);
  assert.deepEqual(await play("a.mp3"), "not-found", "only the trailing extension is stripped");
  assert.deepEqual(await play(".mp3"), "not-found", "file with an empty name stays hidden");
  assert.deepEqual(await play("../secret.mp3"), "invalid-name");
});
