// In-memory stand-ins for @discordjs/voice, so voice.ts can be exercised without Discord.
import { EventEmitter } from "node:events";
import { AudioPlayerStatus, VoiceConnectionStatus } from "@discordjs/voice";

/** Mimics VoiceConnection's state machine: emits "stateChange" and the status-named event. */
export class FakeConnection extends EventEmitter {
  state = { status: VoiceConnectionStatus.Signalling };
  rejoinAttempts = 0;
  destroyCalls = 0;
  rejoinCalls = 0;
  subscribedPlayer = null;

  constructor(joinConfig = {}) {
    super();
    this.joinConfig = joinConfig;
  }

  setState(state) {
    const old = this.state;
    this.state = state;
    this.emit("stateChange", old, state);
    this.emit(state.status, old, state);
  }

  destroy() {
    this.destroyCalls++;
    // Same behaviour as @discordjs/voice.
    if (this.state.status === VoiceConnectionStatus.Destroyed) {
      throw new Error("Cannot destroy VoiceConnection - it has already been destroyed");
    }
    this.setState({ status: VoiceConnectionStatus.Destroyed });
  }

  rejoin() {
    this.rejoinAttempts++;
    this.rejoinCalls++;
    this.setState({ status: VoiceConnectionStatus.Signalling });
    return true;
  }

  subscribe(player) {
    this.subscribedPlayer = player;
    return { unsubscribe: () => { if (this.subscribedPlayer === player) this.subscribedPlayer = null; } };
  }
}

/** Mimics the parts of AudioPlayer that voice.ts uses. */
export class FakePlayer extends EventEmitter {
  static nextId = 1;
  id = FakePlayer.nextId++;
  state = { status: AudioPlayerStatus.Idle };
  nowPlaying = null;

  play(resource) {
    this.nowPlaying = resource;
    this.setStatus(AudioPlayerStatus.Playing);
  }

  stop() {
    if (this.state.status === AudioPlayerStatus.Idle) return false;
    this.nowPlaying = null;
    this.setStatus(AudioPlayerStatus.Idle);
    return true;
  }

  setStatus(status) {
    const old = this.state;
    this.state = { status };
    this.emit("stateChange", old, this.state);
  }
}

/**
 * A fake backend for setVoiceBackend(). Like @discordjs/voice, it keeps one connection per guild,
 * returns the existing one on a repeat join, and forgets it once destroyed.
 */
export function createFakeVoiceBackend() {
  const connections = new Map();
  const players = [];

  return {
    connections,
    players,
    joinVoiceChannel(config) {
      const existing = connections.get(config.guildId);
      if (existing) {
        existing.joinConfig = config;
        return existing;
      }

      const conn = new FakeConnection(config);
      connections.set(config.guildId, conn);
      conn.on("stateChange", (_old, next) => {
        if (next.status === VoiceConnectionStatus.Destroyed && connections.get(config.guildId) === conn) {
          connections.delete(config.guildId);
        }
      });
      // Becomes Ready asynchronously, like a real handshake.
      setImmediate(() => {
        if (conn.state.status !== VoiceConnectionStatus.Destroyed) conn.setState({ status: VoiceConnectionStatus.Ready });
      });
      return conn;
    },
    createAudioPlayer() {
      const player = new FakePlayer();
      players.push(player);
      return player;
    },
    getVoiceConnection(guildId) {
      return connections.get(guildId);
    }
  };
}

/** The minimal VoiceBasedChannel shape connectTo() reads. */
export function fakeVoiceChannel(guildId, channelId) {
  return { id: channelId, guild: { id: guildId, voiceAdapterCreator: () => ({}) } };
}
