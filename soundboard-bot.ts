import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";
import type { Interaction, VoiceBasedChannel } from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  getVoiceConnections,
  AudioPlayer,
  VoiceConnection,
  VoiceConnectionStatus
} from "@discordjs/voice";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";

dotenv.config();

// Discord limits
const MAX_MESSAGE_LENGTH = 2000;
const MAX_ACTION_ROWS = 5;
const MAX_BUTTONS_PER_ROW = 5;
const MAX_BUTTON_LABEL_LENGTH = 80;
const MAX_CUSTOM_ID_LENGTH = 100;

const PLAY_PREFIX = "sb:play:";
// One row is reserved for the Stop/Leave controls.
const MAX_SOUNDBOARD_SOUNDS = (MAX_ACTION_ROWS - 1) * MAX_BUTTONS_PER_ROW;

const SOUNDS_DIR = path.resolve(process.cwd(), "sounds");

// Exit code for errors a restart can't fix (bad config / token). The supervisor won't restart on it.
const EXIT_CONFIG_ERROR = 78;

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error("Missing required environment variables: DISCORD_TOKEN and CLIENT_ID must be set (see .env-example).");
  process.exit(EXIT_CONFIG_ERROR);
}

// Last-resort safety nets so a stray error is logged instead of silently killing the bot.
process.on("unhandledRejection", reason => {
  console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", error => {
  // The process may be in an inconsistent state after an uncaught exception,
  // so log it and exit; the supervisor (npm run exec) restarts the bot.
  console.error("Uncaught exception:", error);
  process.exit(1);
});

async function sendReply(interaction: Interaction, message: string): Promise<void> {
  if (!interaction.isRepliable()) return;

  const content = message.length > MAX_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : message;

  try {
    if (interaction.replied || interaction.deferred) {
      const msg = await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      setTimeout(() => msg.delete().catch(() => {}), 3000);
    } else {
      const msg = await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      setTimeout(() => msg.delete().catch(() => {}), 3000);
    }
  } catch (error) {
    // Typically the interaction expired (not answered within 3s) or was already acknowledged.
    console.error("Failed to reply to interaction:", error);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

// One audio player per guild, so servers don't hear (or stop) each other's sounds.
const players = new Map<string, AudioPlayer>();
const trackedConnections = new WeakSet<VoiceConnection>();

function getPlayer(guildId: string): AudioPlayer {
  let player = players.get(guildId);

  if (!player) {
    player = createAudioPlayer();

    // Without an "error" listener, an AudioPlayer error (bad file, ffmpeg failure, ...) crashes the process.
    player.on("error", error => {
      console.error(`Audio player error in guild ${guildId}:`, error.message);
    });

    players.set(guildId, player);
  }

  return player;
}

function destroyConnection(conn: VoiceConnection): void {
  // destroy() throws if the connection was already destroyed.
  if (conn.state.status !== VoiceConnectionStatus.Destroyed) {
    conn.destroy();
  }
}

function trackConnection(conn: VoiceConnection, guildId: string): void {
  // joinVoiceChannel returns the existing connection for a guild, so only attach listeners once.
  if (trackedConnections.has(conn)) return;
  trackedConnections.add(conn);

  conn.on("error", error => {
    console.error(`Voice connection error in guild ${guildId}:`, error);
  });

  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // If Discord is just moving us (e.g. channel switch), it will reconnect on its own.
      await Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
        entersState(conn, VoiceConnectionStatus.Connecting, 5_000)
      ]);
    } catch {
      // Truly disconnected (kicked, channel deleted, ...). Clean up.
      destroyConnection(conn);
    }
  });

  conn.on(VoiceConnectionStatus.Destroyed, () => {
    const player = players.get(guildId);

    if (player) {
      player.stop(true);
      players.delete(guildId);
    }
  });
}

function connectTo(voiceChannel: VoiceBasedChannel): AudioPlayer {
  const guildId = voiceChannel.guild.id;
  const conn = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator
  });

  trackConnection(conn, guildId);

  const player = getPlayer(guildId);
  conn.subscribe(player);

  // Don't sit half-connected forever (e.g. network issues); give up and clean up instead.
  entersState(conn, VoiceConnectionStatus.Ready, 20_000).catch(() => {
    if (conn.state.status !== VoiceConnectionStatus.Destroyed) {
      console.error(`Voice connection in guild ${guildId} did not become ready in time; disconnecting.`);
      destroyConnection(conn);
    }
  });

  return player;
}

async function leaveVoice(guildId: string, interaction?: Interaction): Promise<void> {
  const conn = getVoiceConnection(guildId);

  if (!conn) {
    if (interaction) {
      await sendReply(interaction, "Not in a voice channel.");
    }

    return;
  }

  // The Destroyed listener stops this guild's player.
  destroyConnection(conn);

  if (interaction) {
    await sendReply(interaction, "Left voice channel.");
  }
}

function getSoundNames(): string[] | null {
  try {
    if (!fs.existsSync(SOUNDS_DIR)) {
      return null;
    }

    return fs.readdirSync(SOUNDS_DIR)
      .filter(file => file.toLowerCase().endsWith(".mp3"))
      .map(file => file.slice(0, -".mp3".length))
      .filter(name => name.length > 0);
  } catch (error) {
    console.error("Failed to read sounds folder:", error);
    return null;
  }
}

/**
 * Returns the caller's voice channel if the bot can join and speak in it,
 * otherwise replies with the reason and returns null.
 */
async function resolveVoiceChannel(interaction: Interaction): Promise<VoiceBasedChannel | null> {
  const voiceChannel = interaction.inCachedGuild() ? interaction.member.voice.channel : null;

  if (!voiceChannel) {
    await sendReply(interaction, "You must be in a voice channel!");
    return null;
  }

  // Without these permissions the connection never becomes ready and nothing plays.
  if (!voiceChannel.joinable) {
    await sendReply(interaction, "I don't have permission to join your voice channel (or it's full).");
    return null;
  }

  const me = voiceChannel.guild.members.me;

  if (!me || !voiceChannel.permissionsFor(me).has(PermissionFlagsBits.Speak)) {
    await sendReply(interaction, "I don't have permission to speak in your voice channel.");
    return null;
  }

  return voiceChannel;
}

async function joinAndPlay(interaction: Interaction, name: string): Promise<void> {
  const names = getSoundNames();

  if (names === null) {
    await sendReply(interaction, "Sounds folder not found.");
    return;
  }

  // Only allow names that exist in the sounds folder. This also prevents
  // path traversal (e.g. "../../something") via the /play name option.
  const fileName = names.find(n => n === name);

  if (fileName === undefined) {
    await sendReply(interaction, "Sound not found.");
    return;
  }

  const voiceChannel = await resolveVoiceChannel(interaction);

  if (!voiceChannel) return;

  const player = connectTo(voiceChannel);

  try {
    const resource = createAudioResource(path.join(SOUNDS_DIR, `${fileName}.mp3`));
    player.play(resource);
  } catch (error) {
    console.error(`Failed to play sound "${fileName}":`, error);
    await sendReply(interaction, "Failed to play that sound.");
    return;
  }

  await sendReply(interaction, `Playing ${fileName} 🔊`);
}

async function stopPlayback(interaction: Interaction): Promise<void> {
  if (!interaction.inGuild()) {
    await sendReply(interaction, "This command can only be used in a server.");
    return;
  }

  if (!getVoiceConnection(interaction.guildId)) {
    await sendReply(interaction, "I'm not in a voice channel.");
    return;
  }

  players.get(interaction.guildId)?.stop(true);

  await sendReply(interaction, "Stopped playback.");
}

async function handleInteraction(interaction: Interaction): Promise<void> {
  if (interaction.isButton()) {
    if (interaction.customId.startsWith(PLAY_PREFIX)) {
      const name = interaction.customId.slice(PLAY_PREFIX.length);

      await joinAndPlay(interaction, name);

      return;
    }

    if (interaction.customId === "sb:stop") {
      await stopPlayback(interaction);

      return;
    }

    if (interaction.customId === "sb:leave") {
      if (!interaction.inGuild()) return;

      await leaveVoice(interaction.guildId, interaction);

      return;
    }
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "join") {
    const voiceChannel = await resolveVoiceChannel(interaction);

    if (!voiceChannel) return;

    connectTo(voiceChannel);

    await sendReply(interaction, "Joined voice channel 🔊");
  }

  if (interaction.commandName === "leave") {
    if (!interaction.inGuild()) {
      await sendReply(interaction, "This command can only be used in a server.");
      return;
    }

    await leaveVoice(interaction.guildId, interaction);
  }

  if (interaction.commandName === "play") {
    const name = interaction.options.getString("name", true);
    await joinAndPlay(interaction, name);
  }

  if (interaction.commandName === "stop") {
    await stopPlayback(interaction);
  }

  if (interaction.commandName === "list") {
    const names = getSoundNames();

    if (names === null) {
      await sendReply(interaction, "Sounds folder not found.");
      return;
    }

    if (names.length === 0) {
      await sendReply(interaction, "No sounds available.");
      return;
    }

    // sendReply truncates to Discord's 2000 character limit if the list gets long.
    await sendReply(interaction, `Available sounds:\n\n${names.map(n => `• ${n}`).join("\n")}`);
  }

  if (interaction.commandName === "soundboard") {
    const names = getSoundNames();

    if (names === null) {
      await sendReply(interaction, "Sounds folder not found.");
      return;
    }

    // Button custom IDs are capped at 100 characters; skip names that would exceed it.
    const playableNames = names.filter(n => PLAY_PREFIX.length + n.length <= MAX_CUSTOM_ID_LENGTH);

    if (playableNames.length === 0) {
      await sendReply(interaction, "No sounds available.");
      return;
    }

    const limitedNames = playableNames.slice(0, MAX_SOUNDBOARD_SOUNDS);
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];

    for (let i = 0; i < limitedNames.length; i += MAX_BUTTONS_PER_ROW) {
      const row = new ActionRowBuilder<ButtonBuilder>();
      const slice = limitedNames.slice(i, i + MAX_BUTTONS_PER_ROW);

      for (const name of slice) {
        const label = name.length > MAX_BUTTON_LABEL_LENGTH
          ? `${name.slice(0, MAX_BUTTON_LABEL_LENGTH - 1)}…`
          : name;

        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`${PLAY_PREFIX}${name}`)
            .setLabel(label)
            .setStyle(ButtonStyle.Secondary)
        );
      }

      rows.push(row);
    }

    const stopRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("sb:stop")
        .setLabel("Stop")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("sb:leave")
        .setLabel("Leave")
        .setStyle(ButtonStyle.Danger)
    );

    rows.push(stopRow);

    const hidden = playableNames.length - limitedNames.length;
    const content = hidden > 0
      ? `Choose a sound to play (${hidden} more not shown, use /play):`
      : "Choose a sound to play:";

    await interaction.reply({
      content,
      components: rows,
      flags: MessageFlags.Ephemeral
    });
  }
}

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user?.tag}`);

  try {
    const route = GUILD_ID
      ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
      : Routes.applicationCommands(CLIENT_ID);

    await rest.put(route, { body: commands });
    console.log(`Slash commands registered (${GUILD_ID ? "guild" : "global"}).`);
  } catch (error) {
    console.error("Failed to register slash commands:", error);
  }
});

client.on("interactionCreate", async (interaction: Interaction) => {
  try {
    await handleInteraction(interaction);
  } catch (error) {
    console.error("Error handling interaction:", error);
    await sendReply(interaction, "Something went wrong. Please try again.");
  }
});

// Leave when the bot's channel has no humans left (including if the bot was moved to an empty channel).
client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    const guild = newState.guild;

    if (!getVoiceConnection(guild.id)) return;

    const botChannel = guild.members.me?.voice.channel;

    if (!botChannel) return;

    if (oldState.channelId !== botChannel.id && newState.channelId !== botChannel.id) return;

    const nonBotMembers = botChannel.members.filter(m => !m.user.bot);

    if (nonBotMembers.size === 0) {
      await leaveVoice(guild.id);
    }
  } catch (error) {
    console.error("Error handling voice state update:", error);
  }
});

// Without an "error" listener, gateway/websocket errors crash the process.
client.on("error", error => {
  console.error("Discord client error:", error);
});

client.on("shardError", error => {
  console.error("Discord websocket error:", error);
});

const commands = [
  new SlashCommandBuilder().setName("join").setDescription("Join your voice channel"),
  new SlashCommandBuilder().setName("leave").setDescription("Leave the voice channel"),
  new SlashCommandBuilder().setName("play").setDescription("Play a sound").addStringOption(option =>
    option.setName("name").setDescription("Name of the sound file").setRequired(true)),
  new SlashCommandBuilder().setName("stop").setDescription("Stops the currently playing sound"),
  new SlashCommandBuilder().setName("list").setDescription("Lists all possible soundtracks"),
  new SlashCommandBuilder().setName("soundboard").setDescription("Open soundboard buttons"),
].map(command => command.toJSON());

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

// Leave voice channels cleanly on Ctrl+C / service stop.
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`Received ${signal}, shutting down...`);

  for (const conn of getVoiceConnections().values()) {
    try {
      destroyConnection(conn);
    } catch (error) {
      console.error("Failed to destroy voice connection during shutdown:", error);
    }
  }

  client.destroy()
    .catch(error => console.error("Failed to destroy client during shutdown:", error))
    .finally(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

client.login(DISCORD_TOKEN).catch(error => {
  console.error("Failed to log in to Discord:", error);

  // A bad token or disallowed intents won't be fixed by restarting.
  const fatal = ["TokenInvalid", "DisallowedIntents"].includes(error?.code);
  process.exit(fatal ? EXIT_CONFIG_ERROR : 1);
});
