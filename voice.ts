import {
  createAudioPlayer,
  entersState,
  joinVoiceChannel,
  AudioPlayer,
  AudioPlayerStatus,
  VoiceConnection,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus
} from "@discordjs/voice";
import type { VoiceConnectionState } from "@discordjs/voice";
import type { VoiceBasedChannel } from "discord.js";

export const READY_TIMEOUT_MS = 20_000;
// How long to wait for Discord to reconnect us on its own after a channel move / region change.
export const RECONNECT_GRACE_MS = 5_000;
export const MAX_REJOIN_ATTEMPTS = 5;
export const REJOIN_BACKOFF_MS = 5_000;

// Close code Discord sends when the bot was moved to another channel or kicked from voice.
const CLOSE_CODE_MOVED_OR_KICKED = 4014;

/**
 * The subset of VoiceConnection used for lifecycle handling.
 * Keeps the logic testable with a fake connection.
 */
export type ManagedConnection = Pick<VoiceConnection, "state" | "rejoinAttempts" | "rejoin" | "destroy" | "on" | "off">;

const players = new Map<string, AudioPlayer>();
const trackedConnections = new WeakSet<object>();

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function getPlayer(guildId: string): AudioPlayer | undefined {
  return players.get(guildId);
}

function getOrCreatePlayer(guildId: string): AudioPlayer {
  let player = players.get(guildId);

  if (!player) {
    player = createAudioPlayer();

    // Without an "error" listener, an AudioPlayer error (bad file, ffmpeg failure, ...) crashes the process.
    player.on("error", error => {
      console.error(`Audio player error in guild ${guildId}:`, error.message);
    });

    player.on("stateChange", (oldState, newState) => {
      if (oldState.status !== newState.status && newState.status === AudioPlayerStatus.AutoPaused) {
        // Playing with no ready connection: the player resumes once the connection is ready again.
        console.warn(`Audio player in guild ${guildId} auto-paused (voice connection not ready).`);
      }
    });

    players.set(guildId, player);
  }

  return player;
}

function releasePlayer(guildId: string): void {
  const player = players.get(guildId);

  if (player) {
    player.stop(true);
    players.delete(guildId);
  }
}

/**
 * Destroys a voice connection. Safe to call any number of times, from any code path
 * (leave command, empty channel, failed reconnect, shutdown): destroy() itself throws
 * if the connection is already destroyed.
 * Returns true if this call destroyed the connection.
 */
export function destroyConnection(conn: ManagedConnection): boolean {
  if (conn.state.status === VoiceConnectionStatus.Destroyed) return false;

  try {
    conn.destroy();
    return true;
  } catch (error) {
    // Another code path won the race; that's fine as long as it ended up destroyed.
    if ((conn.state.status as VoiceConnectionStatus) !== VoiceConnectionStatus.Destroyed) {
      console.error("Failed to destroy voice connection:", error);
    }

    return false;
  }
}

export interface TrackOptions {
  /** Called once when the connection is destroyed (by anyone). */
  onDestroyed?: () => void;
  reconnectGraceMs?: number;
  rejoinBackoffMs?: number;
  maxRejoinAttempts?: number;
}

async function handleDisconnected(
  conn: ManagedConnection,
  guildId: string,
  state: VoiceConnectionState,
  options: Required<Omit<TrackOptions, "onDestroyed">>
): Promise<void> {
  if (state.status !== VoiceConnectionStatus.Disconnected) return;

  if (state.reason === VoiceConnectionDisconnectReason.WebSocketClose && state.closeCode === CLOSE_CODE_MOVED_OR_KICKED) {
    // Either moved to another channel (Discord reconnects us) or kicked (it won't). Wait briefly to find out.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.reconnectGraceMs);

    try {
      await Promise.race([
        entersState(conn as VoiceConnection, VoiceConnectionStatus.Signalling, controller.signal),
        entersState(conn as VoiceConnection, VoiceConnectionStatus.Connecting, controller.signal)
      ]);
    } catch {
      if (conn.state.status === VoiceConnectionStatus.Disconnected) {
        console.log(`Removed from voice in guild ${guildId}; cleaning up.`);
        destroyConnection(conn);
      }
    } finally {
      clearTimeout(timer);
      // Cancels whichever wait didn't win the race.
      controller.abort();
    }

    return;
  }

  if (conn.rejoinAttempts < options.maxRejoinAttempts) {
    // Recoverable drop (network blip, voice server change): back off and rejoin.
    await wait((conn.rejoinAttempts + 1) * options.rejoinBackoffMs);

    // Something else (e.g. /leave) may have destroyed or recovered the connection while we waited.
    if (conn.state.status === VoiceConnectionStatus.Disconnected) {
      console.log(`Rejoining voice in guild ${guildId} (attempt ${conn.rejoinAttempts + 1}/${options.maxRejoinAttempts}).`);
      conn.rejoin();
    }

    return;
  }

  console.error(`Voice connection in guild ${guildId} could not be re-established; cleaning up.`);
  destroyConnection(conn);
}

/** Attaches lifecycle handling to a connection (once per connection object). */
export function trackConnection(conn: ManagedConnection, guildId: string, options: TrackOptions = {}): void {
  // joinVoiceChannel returns the existing connection for a guild, so only attach listeners once.
  if (trackedConnections.has(conn)) return;
  trackedConnections.add(conn);

  const { onDestroyed = () => {} } = options;
  const timings = {
    reconnectGraceMs: options.reconnectGraceMs ?? RECONNECT_GRACE_MS,
    rejoinBackoffMs: options.rejoinBackoffMs ?? REJOIN_BACKOFF_MS,
    maxRejoinAttempts: options.maxRejoinAttempts ?? MAX_REJOIN_ATTEMPTS
  };

  conn.on("error", error => {
    console.error(`Voice connection error in guild ${guildId}:`, error);
  });

  conn.on("stateChange", (oldState, newState) => {
    if (newState.status === VoiceConnectionStatus.Disconnected) {
      // Not deduplicated by status on purpose: a failed rejoin() goes Disconnected -> Disconnected,
      // and that still needs handling (another attempt, or cleanup).
      handleDisconnected(conn, guildId, newState, timings).catch(error => {
        console.error(`Failed to handle voice disconnect in guild ${guildId}:`, error);
        destroyConnection(conn);
      });
    } else if (newState.status === VoiceConnectionStatus.Destroyed && oldState.status !== VoiceConnectionStatus.Destroyed) {
      onDestroyed();
    }
  });
}

export type ConnectResult =
  | { ok: true; player: AudioPlayer }
  | { ok: false; reason: "timeout" | "destroyed" };

/**
 * Joins (or moves to) the given channel and waits until the connection is Ready.
 * On failure the connection is destroyed so the bot doesn't sit half-connected.
 */
export async function connectTo(voiceChannel: VoiceBasedChannel, timeoutMs = READY_TIMEOUT_MS): Promise<ConnectResult> {
  const guildId = voiceChannel.guild.id;
  const conn = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator
  });

  trackConnection(conn, guildId, { onDestroyed: () => releasePlayer(guildId) });

  const ready = await waitUntilReady(conn, guildId, timeoutMs);

  if (!ready.ok) return ready;

  const player = getOrCreatePlayer(guildId);
  conn.subscribe(player);

  return { ok: true, player };
}

export async function waitUntilReady(
  conn: ManagedConnection,
  guildId: string,
  timeoutMs = READY_TIMEOUT_MS
): Promise<{ ok: true } | { ok: false; reason: "timeout" | "destroyed" }> {
  // Stop waiting as soon as the connection is destroyed instead of sitting out the whole timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onStateChange = (_oldState: VoiceConnectionState, newState: VoiceConnectionState) => {
    if (newState.status === VoiceConnectionStatus.Destroyed) controller.abort();
  };

  conn.on("stateChange", onStateChange);

  try {
    await entersState(conn as VoiceConnection, VoiceConnectionStatus.Ready, controller.signal);
    return { ok: true };
  } catch {
    if (conn.state.status === VoiceConnectionStatus.Destroyed) {
      // e.g. /leave or an empty-channel cleanup happened while we were connecting.
      return { ok: false, reason: "destroyed" };
    }

    console.error(`Voice connection in guild ${guildId} did not become ready within ${timeoutMs / 1000}s; disconnecting.`);
    destroyConnection(conn);
    return { ok: false, reason: "timeout" };
  } finally {
    clearTimeout(timer);
    conn.off("stateChange", onStateChange);
  }
}

export function describeConnectFailure(reason: "timeout" | "destroyed"): string {
  return reason === "timeout"
    ? "Couldn't connect to your voice channel in time. Please try again."
    : "The voice connection was closed before it was ready.";
}
