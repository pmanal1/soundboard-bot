import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } from "discord.js";
import type { Interaction } from "discord.js";
import { joinVoiceChannel, createAudioPlayer, createAudioResource, VoiceConnection } from "@discordjs/voice";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

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
      await interaction.reply("You must be in a voice channel!");
      return;
    }

    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator
    });

    connection.subscribe(player);

    await interaction.reply("Joined voice channel 🔊");
  }

  if (interaction.commandName === "leave") {
    if (connection) {
      connection.destroy();
      connection = null;
      await interaction.reply("Left voice channel.");
    } else {
      await interaction.reply("Not in a voice channel.");
    }
  }

  if (interaction.commandName === "sound") {
    const name = interaction.options.getString("name", true);

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    const filePath = path.join(__dirname, "../sounds", `${name}.mp3`);

    if (!fs.existsSync(filePath)) {
      await interaction.reply("Sound not found.");
      return;
    }

    const resource = createAudioResource(filePath);
    player.play(resource);

    await interaction.reply(`Playing ${name} 🔊`);
  }
});

const commands = [
  new SlashCommandBuilder().setName("join").setDescription("Join your voice channel"),
  new SlashCommandBuilder().setName("leave").setDescription("Leave the voice channel"),
  new SlashCommandBuilder().setName("sound").setDescription("Play a sound").addStringOption(option =>
    option.setName("name").setDescription("Name of the sound file").setRequired(true))
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
