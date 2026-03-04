import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";
import type { Interaction } from "discord.js";
import { joinVoiceChannel, createAudioPlayer, createAudioResource, VoiceConnection } from "@discordjs/voice";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

async function sendReply(interaction: Interaction, message: string): Promise<void> {
  if (!interaction.isRepliable()) return;

  const msg = await interaction.reply({ content: message, ephemeral: true });

  setTimeout(() => msg.delete().catch(() => {}), 3000);
}

dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

let connection: VoiceConnection | null = null;
const player = createAudioPlayer();

async function leaveVoice(interaction?: Interaction): Promise<void> {
  if (!connection) {
    if (interaction) {
      await sendReply(interaction, "Not in a voice channel.");
    }

    return;
  }

  connection.destroy();
  connection = null;
  player.stop(true);

  if (interaction) {
    await sendReply(interaction, "Left voice channel.");
  }
}

function getSoundNames(): string[] | null {
  const soundsDir = path.resolve(process.cwd(), "sounds");

  if (!fs.existsSync(soundsDir)) {
    return null;
  }

  const files = fs.readdirSync(soundsDir).filter(file => file.endsWith(".mp3"));

  return files.map(file => file.replace(".mp3", ""));
}

async function joinAndPlay(interaction: Interaction, name: string): Promise<void> {
  const member = (interaction as any).member;
  const voiceChannel = member?.voice?.channel;

  if (!voiceChannel) {
    await sendReply(interaction, "You must be in a voice channel!");
    return;
  }

  connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator
  });

  connection.subscribe(player);

  const soundsDir = path.resolve(process.cwd(), "sounds");

  if (!fs.existsSync(soundsDir)) {
    await sendReply(interaction, "Sounds folder not found.");
    return;
  }

  const filePath = path.join(soundsDir, `${name}.mp3`);

  if (!fs.existsSync(filePath)) {
    await sendReply(interaction, "Sound not found.");
    return;
  }

  const resource = createAudioResource(filePath);
  player.play(resource);

  await sendReply(interaction, `Playing ${name} 🔊`);
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

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user?.tag}`);

  try {
    const route = process.env.GUILD_ID
      ? Routes.applicationGuildCommands(process.env.CLIENT_ID!, process.env.GUILD_ID!)
      : Routes.applicationCommands(process.env.CLIENT_ID!);

    await rest.put(route, { body: commands });
    console.log(`Slash commands registered (${process.env.GUILD_ID ? "guild" : "global"}).`);
  } catch (error) {
    console.error("Failed to register slash commands:", error);
  }
});

client.on("interactionCreate", async (interaction: Interaction) => {
  if (interaction.isButton()) {
    const prefix = "sb:play:";

    if (interaction.customId.startsWith(prefix)) {
      const name = interaction.customId.slice(prefix.length);

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
    const member = interaction.member;
    const voiceChannel = (member as any)?.voice?.channel;

    if (!voiceChannel) {
      await sendReply(interaction, "You must be in a voice channel!");
      return;
    }

    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator
    });

    connection.subscribe(player);

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

    await sendReply(interaction, `Available sounds:\n\n${names.map(n => `• ${n}`).join("\n")}`);
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

    const limitedNames = names.slice(0, 25);
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];

    for (let i = 0; i < limitedNames.length; i += 5) {
      const row = new ActionRowBuilder<ButtonBuilder>();
      const slice = limitedNames.slice(i, i + 5);

      for (const name of slice) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`sb:play:${name}`)
            .setLabel(name)
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

    await interaction.reply({
      content: "Choose a sound to play:",
      components: rows,
      ephemeral: true
    });
  }
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  const member = newState.member ?? oldState.member;

  if (!member || member.user.bot) return;

  const channel = oldState.channel ?? newState.channel;

  if (!channel) return;

  if (!connection) return;

  const connectedChannelId = (connection.joinConfig as any).channelId;

  if (channel.id !== connectedChannelId) return;

  const nonBotMembers = channel.members.filter(m => !m.user.bot);

  if (nonBotMembers.size === 0) {
    await leaveVoice();
  }
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

const rest = new REST({ version: "10"}).setToken(process.env.DISCORD_TOKEN!);

client.login(process.env.DISCORD_TOKEN)
