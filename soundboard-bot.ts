import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  MessageFlags,
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

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error("Missing required environment variables: DISCORD_TOKEN and CLIENT_ID must be set (see .env-example).");
  process.exit(1);
}

// Last-resort safety nets so a stray error is logged instead of silently killing the bot.
process.on("unhandledRejection", reason => {
  console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", error => {
  // The process may be in an inconsistent state after an uncaught exception,
  // so log it and exit; a process manager (systemd, pm2, ...) should restart the bot.
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

let connection: VoiceConnection | null = null;
const trackedConnections = new WeakSet<VoiceConnection>();
const player = createAudioPlayer();

// Without an "error" listener, an AudioPlayer error (bad file, ffmpeg failure, ...) crashes the process.
player.on("error", error => {
  console.error("Audio player error:", error.message);
});

function trackConnection(conn: VoiceConnection): void {
  // joinVoiceChannel returns the existing connection for a guild, so only attach listeners once.
  if (trackedConnections.has(conn)) return;
  trackedConnections.add(conn);

  conn.on("error", error => {
    console.error("Voice connection error:", error);
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
      if (conn.state.status !== VoiceConnectionStatus.Destroyed) {
        conn.destroy();
      }
    }
  });

  conn.on(VoiceConnectionStatus.Destroyed, () => {
    if (connection === conn) {
      connection = null;
      player.stop(true);
    }
  });
}

function connectTo(voiceChannel: VoiceBasedChannel): VoiceConnection {
  const conn = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator
  });

  trackConnection(conn);
  conn.subscribe(player);
  connection = conn;

  return conn;
}

async function leaveVoice(interaction?: Interaction): Promise<void> {
  if (!connection) {
    if (interaction) {
      await sendReply(interaction, "Not in a voice channel.");
    }

    return;
  }

  const conn = connection;
  connection = null;
  player.stop(true);

  // destroy() throws if the connection was already destroyed elsewhere.
  if (conn.state.status !== VoiceConnectionStatus.Destroyed) {
    conn.destroy();
  }

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

function getMemberVoiceChannel(interaction: Interaction): VoiceBasedChannel | null {
  if (!interaction.inCachedGuild()) return null;

  return interaction.member.voice.channel;
}

async function joinAndPlay(interaction: Interaction, name: string): Promise<void> {
  const voiceChannel = getMemberVoiceChannel(interaction);

  if (!voiceChannel) {
    await sendReply(interaction, "You must be in a voice channel!");
    return;
  }

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

  const filePath = path.join(SOUNDS_DIR, `${fileName}.mp3`);

  connectTo(voiceChannel);

  try {
    const resource = createAudioResource(filePath);
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

  if (!connection) {
    await sendReply(interaction, "I'm not in a voice channel.");
    return;
  }

  player.stop(true);

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
      await leaveVoice(interaction);

      return;
    }
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "join") {
    const voiceChannel = getMemberVoiceChannel(interaction);

    if (!voiceChannel) {
      await sendReply(interaction, "You must be in a voice channel!");
      return;
    }

    connectTo(voiceChannel);

    await sendReply(interaction, "Joined voice channel 🔊");
  }

  if (interaction.commandName === "leave") {
    await leaveVoice(interaction);
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

client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    const member = newState.member ?? oldState.member;

    if (!member || member.user.bot) return;

    const channel = oldState.channel ?? newState.channel;

    if (!channel) return;

    if (!connection) return;

    if (channel.id !== connection.joinConfig.channelId) return;

    const nonBotMembers = channel.members.filter(m => !m.user.bot);

    if (nonBotMembers.size === 0) {
      await leaveVoice();
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

client.login(DISCORD_TOKEN).catch(error => {
  console.error("Failed to log in to Discord:", error);
  process.exit(1);
});
