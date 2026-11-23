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
import type { Guild, Interaction, VoiceBasedChannel } from "discord.js";
import { createAudioResource, getVoiceConnection, getVoiceConnections } from "@discordjs/voice";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { describeLookupFailure, listSoundNames, resolveSound } from "./sounds.js";
import { connectTo, describeConnectFailure, destroyConnection, leaveGuild, stopGuildPlayback } from "./voice.js";
import { buildVoiceControlContext, checkVoiceControl, describeVoiceControlRefusal } from "./voice-permissions.js";
import type { VoiceAction } from "./voice-permissions.js";
import { buildSoundboardLayout, LEAVE_ID, parseNavCustomId, PLAY_PREFIX, STOP_ID } from "./soundboard-layout.js";
import type { ButtonSpec } from "./soundboard-layout.js";

dotenv.config();

// Discord limits
const MAX_MESSAGE_LENGTH = 2000;
const MAX_BUTTON_LABEL_LENGTH = 80;

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
    if (interaction.deferred && !interaction.replied) {
      // Fill in the "thinking..." placeholder from deferEphemeral.
      await interaction.editReply({ content });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 3000);
    } else if (interaction.replied || interaction.deferred) {
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

async function deferEphemeral(interaction: Interaction): Promise<void> {
  if (!interaction.isRepliable() || interaction.replied || interaction.deferred) return;

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (error) {
    console.error("Failed to defer interaction:", error);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

async function leaveVoice(guildId: string, interaction?: Interaction): Promise<void> {
  if (!getVoiceConnection(guildId)) {
    if (interaction) {
      await sendReply(interaction, "Not in a voice channel.");
    }

    return;
  }

  // Automatic leaves (empty channel) pass no interaction and skip the check.
  if (interaction && !await ensureCanControlVoice(interaction, "leave")) return;

  // Only this guild's connection and player are torn down; other servers keep playing.
  leaveGuild(guildId);

  if (interaction) {
    await sendReply(interaction, "Left voice channel.");
  }
}

/** The channel the bot is connected to in this guild, or null if it isn't connected. */
function getBotVoiceChannel(guild: Guild): VoiceBasedChannel | null {
  const conn = getVoiceConnection(guild.id);

  if (!conn) return null;

  // The bot's own voice state is the source of truth; joinConfig covers the window while it's still connecting.
  const channelId = guild.members.me?.voice.channelId ?? conn.joinConfig.channelId;
  const channel = channelId ? guild.channels.cache.get(channelId) : undefined;

  return channel?.isVoiceBased() ? channel : null;
}

/**
 * Stops the caller from moving, stopping or disconnecting the bot while it's playing for other people
 * in a channel the caller isn't in (see voice-permissions.ts). Replies with the reason and returns false if refused.
 */
async function ensureCanControlVoice(interaction: Interaction, action: VoiceAction): Promise<boolean> {
  if (!interaction.inCachedGuild()) {
    // Without the cached member we can't tell which channel they're in; fail closed.
    await sendReply(interaction, "Couldn't check your voice channel. Please try again.");
    return false;
  }

  const member = interaction.member;
  const botChannel = getBotVoiceChannel(interaction.guild);
  const canBypass = botChannel?.permissionsFor(member).has(PermissionFlagsBits.MoveMembers) ?? false;
  const decision = checkVoiceControl(buildVoiceControlContext(member, botChannel, canBypass));

  if (decision === "refused" && botChannel) {
    await sendReply(interaction, describeVoiceControlRefusal(action, botChannel.id));
    return false;
  }

  if (decision === "bypass") {
    console.log(`${member.user.tag} used Move Members to ${action} the bot away from listeners in guild ${interaction.guildId}.`);
  }

  return true;
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

  if (!await ensureCanControlVoice(interaction, "summon")) return;

  // Connecting can take a few seconds; acknowledge first so the interaction doesn't expire.
  await deferEphemeral(interaction);

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

  await sendReply(interaction, `Playing ${sound.name} 🔊`);
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

  if (!await ensureCanControlVoice(interaction, "stop")) return;

  // Stops this guild's player only.
  stopGuildPlayback(interaction.guildId);

  await sendReply(interaction, "Stopped playback.");
}

function toButton(spec: ButtonSpec): ButtonBuilder {
  const button = new ButtonBuilder().setCustomId(spec.customId);

  switch (spec.kind) {
    case "sound": {
      const label = spec.name.length > MAX_BUTTON_LABEL_LENGTH
        ? `${spec.name.slice(0, MAX_BUTTON_LABEL_LENGTH - 1)}…`
        : spec.name;

      return button.setLabel(label).setStyle(ButtonStyle.Secondary);
    }
    case "nav":
    case "indicator":
      return button.setLabel(spec.label).setStyle(ButtonStyle.Primary).setDisabled(spec.disabled);
    case "control":
      return button.setLabel(spec.label).setStyle(ButtonStyle.Danger);
  }
}

/** Builds the soundboard message for a page; out-of-range pages are clamped. */
function soundboardMessage(names: string[], page: number) {
  const layout = buildSoundboardLayout(names, page);

  const content = layout.totalSounds === 0
    ? "No sounds available."
    : layout.pageCount > 1
      ? `Choose a sound to play (page ${layout.page + 1} of ${layout.pageCount}, ${layout.totalSounds} sounds):`
      : "Choose a sound to play:";

  const components = layout.rows.map(row =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(row.map(toButton)));

  return { content, components, isEmpty: layout.totalSounds === 0 };
}

async function handleInteraction(interaction: Interaction): Promise<void> {
  if (interaction.isButton()) {
    const navPage = parseNavCustomId(interaction.customId);

    if (navPage !== null) {
      const names = getSoundNames();

      if (names === null) {
        await sendReply(interaction, "Sounds folder not found.");
        return;
      }

      // Re-read the folder and edit the board in place; the page is clamped if sounds were removed.
      const { content, components } = soundboardMessage(names, navPage);
      await interaction.update({ content, components });

      return;
    }

    if (interaction.customId.startsWith(PLAY_PREFIX)) {
      const name = interaction.customId.slice(PLAY_PREFIX.length);

      await joinAndPlay(interaction, name);

      return;
    }

    if (interaction.customId === STOP_ID) {
      await stopPlayback(interaction);

      return;
    }

    if (interaction.customId === LEAVE_ID) {
      if (!interaction.inGuild()) return;

      await leaveVoice(interaction.guildId, interaction);

      return;
    }
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "join") {
    const voiceChannel = await resolveVoiceChannel(interaction);

    if (!voiceChannel) return;

    if (!await ensureCanControlVoice(interaction, "summon")) return;

    await deferEphemeral(interaction);

    const connection = await connectTo(voiceChannel);

    await sendReply(interaction, connection.ok ? "Joined voice channel 🔊" : describeConnectFailure(connection.reason));
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

    const { content, components, isEmpty } = soundboardMessage(names, 0);

    if (isEmpty) {
      await sendReply(interaction, content);
      return;
    }

    await interaction.reply({
      content,
      components,
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
