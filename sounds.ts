import fs from "fs";
import path from "path";

export const SOUND_EXTENSION = ".mp3";

// Longer than any real clip name; keeps junk input from reaching the filesystem.
export const MAX_SOUND_NAME_LENGTH = 100;

export type SoundLookup =
  | { ok: true; name: string; filePath: string }
  | { ok: false; reason: "invalid-name" | "no-folder" | "not-found" | "outside-folder" | "unreadable" };

/**
 * A sound name is a bare file name without the extension: no path separators,
 * no "." / ".." segments, no control characters (including NUL).
 */
export function isValidSoundName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_SOUND_NAME_LENGTH) return false;
  if (name.trim() !== name) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return false;

  return true;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Lists playable sound names, or null if the folder is missing or unreadable. */
export function listSoundNames(soundsDir: string): string[] | null {
  let entries: fs.Dirent[];

  try {
    entries = fs.readdirSync(soundsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("Failed to read sounds folder:", error);
    }

    return null;
  }

  return entries
    .filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase().endsWith(SOUND_EXTENSION))
    .map(entry => entry.name.slice(0, -SOUND_EXTENSION.length))
    .filter(isValidSoundName);
}

/**
 * Resolves a user-supplied sound name to a readable file inside soundsDir.
 * The real path (symlinks followed) must stay inside the real sounds folder,
 * so neither "../" tricks nor symlinks can reach other files.
 */
export async function resolveSound(soundsDir: string, name: string): Promise<SoundLookup> {
  if (!isValidSoundName(name)) return { ok: false, reason: "invalid-name" };

  let realDir: string;

  try {
    realDir = await fs.promises.realpath(soundsDir);
  } catch {
    return { ok: false, reason: "no-folder" };
  }

  let entries: string[];

  try {
    entries = await fs.promises.readdir(realDir);
  } catch {
    return { ok: false, reason: "no-folder" };
  }

  // Only names that are actually listed in the folder can be played (extension matched case-insensitively,
  // so "Clip.MP3" works the same way it is shown in /list).
  const fileName = entries.find(entry =>
    entry.length === name.length + SOUND_EXTENSION.length
    && entry.startsWith(name)
    && entry.slice(name.length).toLowerCase() === SOUND_EXTENSION);

  if (fileName === undefined) return { ok: false, reason: "not-found" };

  const candidate = path.join(realDir, fileName);

  // Defense in depth: isValidSoundName should already make this impossible.
  if (path.dirname(candidate) !== realDir) return { ok: false, reason: "invalid-name" };

  let realFile: string;

  try {
    realFile = await fs.promises.realpath(candidate);
  } catch {
    return { ok: false, reason: "not-found" };
  }

  if (!isInside(realDir, realFile)) return { ok: false, reason: "outside-folder" };

  try {
    const stat = await fs.promises.stat(realFile);

    if (!stat.isFile()) return { ok: false, reason: "not-found" };

    await fs.promises.access(realFile, fs.constants.R_OK);
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  return { ok: true, name, filePath: realFile };
}

export function describeLookupFailure(reason: Exclude<SoundLookup, { ok: true }>["reason"]): string {
  switch (reason) {
    case "invalid-name":
      return "That isn't a valid sound name. Use /list to see available sounds.";
    case "no-folder":
      return "Sounds folder not found.";
    case "not-found":
    case "outside-folder":
      // Don't reveal whether a file exists outside the sounds folder.
      return "Sound not found. Use /list to see available sounds.";
    case "unreadable":
      return "That sound file can't be read.";
  }
}
