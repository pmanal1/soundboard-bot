// Pure soundboard layout: sound names + page -> rows of button specs.
// No discord.js here, so it can be unit tested and printed by the demo script.

// Discord limits for a single message.
export const MAX_ACTION_ROWS = 5;
export const MAX_BUTTONS_PER_ROW = 5;
export const MAX_CUSTOM_ID_LENGTH = 100;

export const PLAY_PREFIX = "sb:play:";
export const STOP_ID = "sb:stop";
export const LEAVE_ID = "sb:leave";
const NAV_PREFIX = "sb:nav:";
const NAV_INDICATOR_ID = `${NAV_PREFIX}page`;

// One row is reserved for controls (Prev / page indicator / Next / Stop / Leave).
export const SOUND_ROWS_PER_PAGE = MAX_ACTION_ROWS - 1;
export const SOUNDS_PER_PAGE = SOUND_ROWS_PER_PAGE * MAX_BUTTONS_PER_ROW;

export type ButtonSpec =
  | { kind: "sound"; customId: string; name: string }
  | { kind: "nav"; customId: string; label: string; disabled: boolean }
  | { kind: "indicator"; customId: string; label: string; disabled: true }
  | { kind: "control"; customId: string; label: string };

export interface SoundboardLayout {
  /** The page actually shown, after clamping. 0-based. */
  page: number;
  /** Always at least 1, even with no sounds. */
  pageCount: number;
  /** Number of sounds that fit a button (see soundboardNames). */
  totalSounds: number;
  /** Sound rows first, then the control row. Never more than MAX_ACTION_ROWS. */
  rows: ButtonSpec[][];
}

/**
 * Names that can be shown as buttons, in order: drops names whose custom ID would exceed
 * Discord's 100-character limit and duplicates (e.g. "a.mp3" and "a.MP3"), since custom IDs
 * must be unique within a message.
 */
export function soundboardNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const name of names) {
    if (PLAY_PREFIX.length + name.length > MAX_CUSTOM_ID_LENGTH) continue;
    if (seen.has(name)) continue;

    seen.add(name);
    result.push(name);
  }

  return result;
}

export function pageCountFor(soundCount: number): number {
  return Math.max(1, Math.ceil(soundCount / SOUNDS_PER_PAGE));
}

/** Clamps any page number (negative, too large, NaN) into [0, pageCount - 1]. */
export function clampPage(page: number, pageCount: number): number {
  if (!Number.isFinite(page)) return 0;
  return Math.min(Math.max(0, Math.trunc(page)), Math.max(0, pageCount - 1));
}

export function navCustomId(direction: "prev" | "next", targetPage: number): string {
  return `${NAV_PREFIX}${direction}:${targetPage}`;
}

/**
 * Returns the requested page for a Prev/Next button, or null if the custom ID isn't one.
 * The result is not clamped: sounds may have been removed since the message was sent.
 */
export function parseNavCustomId(customId: string): number | null {
  const match = /^sb:nav:(?:prev|next):(\d{1,9})$/.exec(customId);
  return match ? Number(match[1]) : null;
}

export function buildSoundboardLayout(names: readonly string[], requestedPage: number): SoundboardLayout {
  const playable = soundboardNames(names);
  const pageCount = pageCountFor(playable.length);
  const page = clampPage(requestedPage, pageCount);
  const pageNames = playable.slice(page * SOUNDS_PER_PAGE, (page + 1) * SOUNDS_PER_PAGE);

  const rows: ButtonSpec[][] = [];

  for (let i = 0; i < pageNames.length; i += MAX_BUTTONS_PER_ROW) {
    rows.push(pageNames.slice(i, i + MAX_BUTTONS_PER_ROW).map(name => ({
      kind: "sound" as const,
      customId: `${PLAY_PREFIX}${name}`,
      name
    })));
  }

  const controls: ButtonSpec[] = [];

  // Only show paging when there is more than one page.
  if (pageCount > 1) {
    // Disabled buttons still need unique custom IDs, so Prev/Next carry a direction as well as a page.
    controls.push(
      { kind: "nav", customId: navCustomId("prev", Math.max(0, page - 1)), label: "◀ Prev", disabled: page === 0 },
      { kind: "indicator", customId: NAV_INDICATOR_ID, label: `${page + 1} / ${pageCount}`, disabled: true },
      { kind: "nav", customId: navCustomId("next", Math.min(pageCount - 1, page + 1)), label: "Next ▶", disabled: page === pageCount - 1 }
    );
  }

  controls.push(
    { kind: "control", customId: STOP_ID, label: "Stop" },
    { kind: "control", customId: LEAVE_ID, label: "Leave" }
  );

  rows.push(controls);

  return { page, pageCount, totalSounds: playable.length, rows };
}
