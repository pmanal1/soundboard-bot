// Simulates two Discord servers using the bot at once, with no token or network,
// to show that each server's voice state is independent.
// Run with: npm run demo:guilds
import { connectTo, getActiveGuildIds, getPlayer, leaveGuild, setVoiceBackend, stopGuildPlayback } from "../dist/voice.js";
import { createFakeVoiceBackend, fakeVoiceChannel } from "../test/helpers/fake-voice.js";

const fake = createFakeVoiceBackend();
const restore = setVoiceBackend(fake);

const GUILDS = { A: "111111111111111111", B: "222222222222222222" };
const label = id => (id === GUILDS.A ? "Server A" : "Server B");

function snapshot(title) {
  console.log(`\n${title}`);
  for (const id of Object.values(GUILDS)) {
    const conn = fake.connections.get(id);
    const player = getPlayer(id);
    const connText = (conn ? `connection ${conn.state.status} (#${conn.joinConfig.channelId})` : "connection none").padEnd(32);
    const playerText = player ? `player #${player.id} ${player.state.status}${player.nowPlaying ? ` -> ${player.nowPlaying}` : ""}` : "player none";
    console.log(`  ${label(id)}: ${connText} | ${playerText}`);
  }
}

async function play(guildId, channelId, sound) {
  const result = await connectTo(fakeVoiceChannel(guildId, channelId), 1_000);
  if (!result.ok) throw new Error(`connect failed: ${result.reason}`);
  result.player.play(sound);
}

await play(GUILDS.A, "a-general", "airhorn.mp3");
snapshot("1. Server A plays airhorn.mp3");

await play(GUILDS.B, "b-gaming", "bruh.mp3");
snapshot("2. Server B plays bruh.mp3 (A must keep playing, not be dropped)");

stopGuildPlayback(GUILDS.A);
snapshot("3. /stop in Server A (B must keep playing)");

await play(GUILDS.A, "a-general", "airhorn.mp3");
leaveGuild(GUILDS.B);
snapshot("4. A plays again, then /leave in Server B (A must keep playing)");

await play(GUILDS.B, "b-gaming", "bruh.mp3");
snapshot("5. Server B joins again (B gets a fresh player; A untouched)");

for (const id of getActiveGuildIds()) leaveGuild(id);
snapshot("6. Shutdown: both servers leave");

restore();
