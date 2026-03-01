import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } from "discord.js";
import type { Interaction } from "discord.js";
import { joinVoiceChannel, createAudioPlayer, createAudioResource, VoiceConnection } from "@discordjs/voice";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

async function sendReply(interaction: Interaction, message: string): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  const msg = await interaction.reply({ content: message, ephemeral: true });

  setTimeout(() => msg.delete().catch(() => {}), 10000);
}

dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

let connection: VoiceConnection | null = null;
const player = createAudioPlayer();

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user?.tag}`);
});

client.on("interactionCreate", async (interaction: Interaction) => {
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

    if (connection) {
      connection.destroy();
      connection = null;
      await sendReply(interaction, "Left voice channel.");
    } else {
      await sendReply(interaction, "Not in a voice channel.");
    }
  }

  if (interaction.commandName === "play") {
    const member = interaction.member;
    const voiceChannel = (member as any)?.voice?.channel;

    if (!voiceChannel) {
      await sendReply(interaction, "You must be in a voice channel!");
      return;
    }

    if (voiceChannel) {
      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator
      });

      connection.subscribe(player);
    }

    const name = interaction.options.getString("name", true);

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    const filePath = path.join(__dirname, "../sounds", `${name}.mp3`);

    if (!fs.existsSync(filePath)) {
      await sendReply(interaction, "Sound not found.");
      return;
    }

    const resource = createAudioResource(filePath);
    player.play(resource);

    await sendReply(interaction, `Playing ${name} 🔊`);
  }

  if (interaction.commandName === "pause") {
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

  if (interaction.commandName === "list") {
    const soundsDir = path.resolve(process.cwd(), "sounds");

    if (!fs.existsSync(soundsDir)) {
      await sendReply(interaction, "Sounds folder not found.");
      return;
    }

    const files = fs.readdirSync(soundsDir).filter(file => file.endsWith(".mp3"));
    if (files.length === 0) {
      await sendReply(interaction, "No sounds available.");
      return;
    }

    const names = files.map(file => file.replace(".mp3", ""));

    await sendReply(interaction, `Available sounds:\n\n${names.map(n => `• ${n}`).join("\n")}`);
  }
});

const commands = [
  new SlashCommandBuilder().setName("join").setDescription("Join your voice channel"),
  new SlashCommandBuilder().setName("leave").setDescription("Leave the voice channel"),
  new SlashCommandBuilder().setName("play").setDescription("Play a sound").addStringOption(option =>
    option.setName("name").setDescription("Name of the sound file").setRequired(true)),
  new SlashCommandBuilder().setName("pause").setDescription("Pauses the currently playing sound"),
  new SlashCommandBuilder().setName("list").setDescription("Lists all possible soundtracks"),
].map(command => command.toJSON());

const rest = new REST({ version: "10"}).setToken(process.env.DISCORD_TOKEN!);

(async () => {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID!, process.env.GUILD_ID!),
    { body: commands }
  );

  console.log("Slash commands registered.");
  
})();

client.login(process.env.DISCORD_TOKEN)
