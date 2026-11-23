// Pure helpers for text the bot shows in Discord: button labels, custom IDs, sound lists and
// reply cleanup. No discord.js imports, so they can be unit tested and run by the demo script.
import { createHash } from "node:crypto";

// Discord limits. discord.js checks them with String#length (UTF-16 code units), which is never
// less than Discord's own count, so staying within them by .length is always safe.
export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_BUTTON_LABEL_LENGTH = 80;
export const MAX_CUSTOM_ID_LENGTH = 100;

const ELLIPSIS = "…";
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Shortens text to at most maxLength code units, ending in "…" when cut. Cuts only between
 * graphemes, so emoji, flags and accented letters are never split into broken characters.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 0) return "";

  const budget = maxLength - ELLIPSIS.length;
  let result = "";

  for (const { segment } of segmenter.segment(text)) {
    if (result.length + segment.length > budget) break;
    result += segment;
  }

  return `${result.trimEnd()}${ELLIPSIS}`;
}

/** Button label for a sound name: never empty, never over Discord's 80-character limit. */
export function formatLabel(name: string, maxLength = MAX_BUTTON_LABEL_LENGTH): string {
  const label = truncate(name.trim(), maxLength);
  return label.length > 0 ? label : "(unnamed)";
}

// Play buttons carry the sound name in their custom ID when it fits, which keeps IDs readable and
// soundboards that are already open working. Longer names use a hash of the name instead, which
// is mapped back to a name in the current sounds folder when the button is pressed.
export const PLAY_PREFIX = "sb:play:";
export const PLAY_KEY_PREFIX = "sb:playk:";

/** Stable 22-character (132-bit) key for a sound name. */
export function soundKey(name: string): string {
  return createHash("sha256").update(name, "utf8").digest("base64url").slice(0, 22);
}

export function playCustomId(name: string): string {
  const direct = `${PLAY_PREFIX}${name}`;
  return direct.length <= MAX_CUSTOM_ID_LENGTH ? direct : `${PLAY_KEY_PREFIX}${soundKey(name)}`;
}

export type PlayTarget = { kind: "name"; name: string } | { kind: "key"; key: string };

/** Reads a play button's custom ID. Returns null if it isn't one. The result is untrusted input. */
export function parsePlayCustomId(customId: string): PlayTarget | null {
  if (customId.startsWith(PLAY_PREFIX)) {
    return { kind: "name", name: customId.slice(PLAY_PREFIX.length) };
  }

  if (customId.startsWith(PLAY_KEY_PREFIX)) {
    return { kind: "key", key: customId.slice(PLAY_KEY_PREFIX.length) };
  }

  return null;
}

/** The sound whose key matches, or null if none (or, absurdly, more than one) does. */
export function findSoundByKey(names: readonly string[], key: string): string | null {
  const matches = names.filter(name => soundKey(name) === key);
  return matches.length === 1 ? matches[0]! : null;
}

export const defaultMoreNote = (count: number): string => `…and ${count} more`;

export interface ChunkListOptions {
  /** Maximum length of each chunk (default: Discord's 2000-character message limit). */
  maxLength?: number;
  /** Maximum number of chunks; items that don't fit are summarised by moreNote. */
  maxChunks?: number;
  /** Text placed before the first item of the first chunk. */
  header?: string;
  moreNote?: (count: number) => string;
}

/**
 * Splits lines into newline-joined chunks that each fit maxLength, without splitting a line
 * across chunks (a single line longer than a chunk is truncated). If more than maxChunks would
 * be needed, the last chunk ends with a note such as "…and 42 more".
 */
export function chunkList(lines: readonly string[], options: ChunkListOptions = {}): string[] {
  const {
    maxLength = MAX_MESSAGE_LENGTH,
    maxChunks = Infinity,
    header,
    moreNote = defaultMoreNote
  } = options;

  if (maxChunks < 1 || maxLength < 1) return [];

  const chunks: string[][] = [];
  let current: string[] = header === undefined ? [] : [header];
  let currentLength = header === undefined ? 0 : header.length;
  let remaining = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = truncate(lines[i]!, maxLength);
    const added = (current.length > 0 ? 1 : 0) + line.length;

    if (currentLength + added <= maxLength) {
      current.push(line);
      currentLength += added;
      continue;
    }

    if (chunks.length + 1 >= maxChunks) {
      remaining = lines.length - i;
      break;
    }

    chunks.push(current);
    current = [line];
    currentLength = line.length;
  }

  if (remaining > 0) {
    // Make room for the note by dropping items (never the header) from the last chunk.
    const firstItem = chunks.length === 0 && header !== undefined ? 1 : 0;
    const fits = () => [...current, moreNote(remaining)].join("\n").length <= maxLength;

    while (!fits() && current.length > firstItem) {
      current.pop();
      remaining++;
    }

    current.push(moreNote(remaining));
  }

  chunks.push(current);

  // Final guarantee, e.g. for a header or note that alone is longer than maxLength.
  return chunks
    .map(chunk => truncate(chunk.join("\n"), maxLength))
    .filter(chunk => chunk.length > 0);
}

/**
 * Runs remove() after delayMs and ignores any failure (the user may already have dismissed the
 * message, or the interaction token expired). Never throws and never causes an unhandled
 * rejection. The timer doesn't keep the process alive.
 */
export function deleteLater(
  remove: () => unknown,
  delayMs: number,
  onError: (error: unknown) => void = () => {}
): ReturnType<typeof setTimeout> {
  const report = (error: unknown) => {
    try {
      onError(error);
    } catch {
      // A failing error handler must not crash the bot either.
    }
  };

  const timer = setTimeout(() => {
    try {
      Promise.resolve(remove()).catch(report);
    } catch (error) {
      report(error);
    }
  }, delayMs);

  timer.unref?.();

  return timer;
}
