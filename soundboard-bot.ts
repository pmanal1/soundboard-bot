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
import { createAudioResource, getVoiceConnection, getVoiceConnections } from "@discordjs/voice";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { describeLookupFailure, listSoundNames, resolveSound } from "./sounds.js";
import { acknowledge, sendReply, sendStatus } from "./replies.js";
import { chunkList, findSoundByKey, formatLabel, MAX_MESSAGE_LENGTH, parsePlayCustomId, playCustomId } from "./sound-text.js";
import { connectTo, describeConnectFailure, destroyConnection, getPlayer } from "./voice.js";

dotenv.config();

// Discord limits
const MAX_ACTION_ROWS = 5;
const MAX_BUTTONS_PER_ROW = 5;

// One row is reserved for the Stop/Leave controls.
const MAX_SOUNDBOARD_SOUNDS = (MAX_ACTION_ROWS - 1) * MAX_BUTTONS_PER_ROW;

const SOUNDS_DIR = path.resolve(process.cwd(), "sounds");

// /list sends at most this many messages; anything beyond ends with "…and N more".
const MAX_LIST_MESSAGES = 3;

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

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

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
    await sendStatus(interaction, "Left voice channel.");
  }
}

function getSoundNames(): string[] | null {
  return listSoundNames(SOUNDS_DIR);
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
  // Validate the sound before touching voice, so a bad name never moves the bot to another channel.
  const sound = await resolveSound(SOUNDS_DIR, name);

  if (!sound.ok) {
    if (sound.reason === "outside-folder") {
      console.warn(`Rejected sound "${name}": resolves outside the sounds folder.`);
    }

    await sendReply(interaction, describeLookupFailure(sound.reason));
    return;
  }

  const voiceChannel = await resolveVoiceChannel(interaction);

  if (!voiceChannel) return;

  // Connecting can take a few seconds; acknowledge first so the interaction doesn't expire.
  await acknowledge(interaction);

  const connection = await connectTo(voiceChannel);

  if (!connection.ok) {
    await sendReply(interaction, describeConnectFailure(connection.reason));
    return;
  }

  try {
    // Stream the already-validated file ourselves rather than handing ffmpeg a path.
    const stream = fs.createReadStream(sound.filePath);
    stream.on("error", error => console.error(`Failed to read sound "${sound.name}":`, error.message));

    connection.player.play(createAudioResource(stream));
  } catch (error) {
    console.error(`Failed to play sound "${sound.name}":`, error);
    await sendReply(interaction, "Failed to play that sound.");
    return;
  }

  await sendStatus(interaction, `Playing ${sound.name} 🔊`);
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

  getPlayer(interaction.guildId)?.stop(true);

  await sendStatus(interaction, "Stopped playback.");
}

async function handleInteraction(interaction: Interaction): Promise<void> {
  if (interaction.isButton()) {
    const playTarget = parsePlayCustomId(interaction.customId);

    if (playTarget) {
      // Long names are sent as a hash; map it back to a name in the folder as it is now.
      // joinAndPlay still validates and resolves that name like any other.
      const name = playTarget.kind === "name"
        ? playTarget.name
        : findSoundByKey(getSoundNames() ?? [], playTarget.key);

      if (name === null) {
        await sendReply(interaction, "That sound is no longer available. Use /list to see available sounds.");
        return;
      }

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

    await acknowledge(interaction);

    const connection = await connectTo(voiceChannel);

    if (connection.ok) {
      await sendStatus(interaction, "Joined voice channel 🔊");
    } else {
      await sendReply(interaction, describeConnectFailure(connection.reason));
    }
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

    const chunks = chunkList(names.map(name => `• ${name}`), {
      maxLength: MAX_MESSAGE_LENGTH,
      maxChunks: MAX_LIST_MESSAGES,
      header: `Available sounds (${names.length}):\n`,
      moreNote: count => `…and ${count} more. Use /play with the exact name to play one.`
    });

    // The first chunk is the reply, the rest are follow-ups. Kept until the user dismisses them.
    for (const chunk of chunks) {
      await sendReply(interaction, chunk, null);
    }
  }

  if (interaction.commandName === "soundboard") {
    const names = getSoundNames();

    if (names === null) {
      await sendReply(interaction, "Sounds folder not found.");
      return;
    }

    if (names.length === 0) {
      await sendReply(interaction, "No sounds available.");
      return;
    }

    const limitedNames = names.slice(0, MAX_SOUNDBOARD_SOUNDS);
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];

    for (let i = 0; i < limitedNames.length; i += MAX_BUTTONS_PER_ROW) {
      const row = new ActionRowBuilder<ButtonBuilder>();
      const slice = limitedNames.slice(i, i + MAX_BUTTONS_PER_ROW);

      for (const name of slice) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(playCustomId(name))
            .setLabel(formatLabel(name))
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

    const hidden = names.length - limitedNames.length;
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
    // destroyConnection never throws, even if a connection is already being torn down.
    destroyConnection(conn);
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
