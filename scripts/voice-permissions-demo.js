// Shows who can move/stop/disconnect the bot, before and after the same-channel check.
// No Discord token needed: runs the pure permission check against simulated guild states.
// Usage: npm run demo:voice-permissions
import {
  buildVoiceControlContext,
  checkVoiceControl,
  describeVoiceControlRefusal
} from "../dist/voice-permissions.js";

const channel = (id, ...members) => ({
  id,
  members: new Map(members.map(name => [name, { user: { bot: name === "bot" } }]))
});

const scenarios = [
  { who: "carol (in #general)", action: "summon", via: "/play airhorn", channelId: "general", botChannel: channel("music", "bot", "alice", "bob") },
  { who: "carol (in #general)", action: "stop", via: "Stop button", channelId: "general", botChannel: channel("music", "bot", "alice", "bob") },
  { who: "carol (not in voice)", action: "leave", via: "/leave", channelId: null, botChannel: channel("music", "bot", "alice", "bob") },
  { who: "carol (in #general)", action: "summon", via: "/join", channelId: "general", botChannel: channel("music", "bot", "alice") },
  { who: "alice (in #music)", action: "stop", via: "/stop", channelId: "music", botChannel: channel("music", "bot", "alice", "bob") },
  { who: "alice (in #music)", action: "leave", via: "Leave button", channelId: "music", botChannel: channel("music", "bot", "alice", "bob") },
  { who: "carol (in #general)", action: "summon", via: "/play airhorn", channelId: "general", botChannel: null, note: "bot idle" },
  { who: "carol (in #general)", action: "summon", via: "/join", channelId: "general", botChannel: channel("music", "bot"), note: "bot alone" },
  { who: "mod (in #general, Move Members)", action: "leave", via: "/leave", channelId: "general", botChannel: channel("music", "bot", "alice", "bob"), canBypass: true }
];

const describeBot = s => s.note ?? `bot in #${s.botChannel.id} with ${[...s.botChannel.members.keys()].filter(n => n !== "bot").join(", ")}`;

scenarios.forEach((s, i) => {
  const ctx = buildVoiceControlContext({ id: s.who.split(" ")[0], voice: { channelId: s.channelId } }, s.botChannel, s.canBypass ?? false);
  const decision = checkVoiceControl(ctx);
  const after = decision === "refused"
    ? `REFUSED  -> "${describeVoiceControlRefusal(s.action, ctx.botChannelId).replace(/<#(\w+)>/, "#$1")}"`
    : decision === "bypass" ? "allowed (Move Members bypass)" : "allowed";

  console.log(`${i + 1}. ${s.who} runs ${s.via} [${describeBot(s)}]`);
  console.log(`   before: allowed`);
  console.log(`   after:  ${after}`);
});
