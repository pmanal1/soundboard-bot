/**
 * Who may move, stop or disconnect the bot.
 *
 * Rule: while the bot is connected and has other (non-bot) listeners in its channel, only members
 * in that same channel can control it. If the bot is idle or alone, anyone may summon or control it.
 *
 * Bypass: members with the Move Members permission in the bot's channel (which includes Administrators)
 * skip the check. Discord already lets them drag or disconnect the bot by hand, so the check would add
 * nothing for them. Manage Guild is deliberately not a bypass: it doesn't grant any voice moderation.
 */

/** "summon" covers anything that can bring the bot to the caller's channel: /join, /play and soundboard buttons. */
export type VoiceAction = "summon" | "stop" | "leave";

export interface VoiceControlContext {
  /** The bot's current voice channel, or null if it isn't connected. */
  botChannelId: string | null;
  /** The invoking member's voice channel, or null if they aren't in one. */
  memberChannelId: string | null;
  /** Non-bot members in the bot's channel, not counting the invoking member. */
  otherListeners: number;
  /** The member has Move Members in the bot's channel. */
  canBypass: boolean;
}

export type VoiceControlDecision = "allowed" | "bypass" | "refused";

export function checkVoiceControl(ctx: VoiceControlContext): VoiceControlDecision {
  if (ctx.botChannelId === null) return "allowed";
  if (ctx.memberChannelId === ctx.botChannelId) return "allowed";
  if (ctx.otherListeners === 0) return "allowed";
  return ctx.canBypass ? "bypass" : "refused";
}

/**
 * Builds the context from the invoking member and the bot's channel.
 * Takes plain shapes (satisfied by discord.js GuildMember / VoiceBasedChannel) so it can be tested with fakes.
 */
export function buildVoiceControlContext(
  member: { id: string; voice: { channelId: string | null } },
  botChannel: { id: string; members: ReadonlyMap<string, { user: { bot: boolean } }> } | null,
  canBypass: boolean
): VoiceControlContext {
  let otherListeners = 0;

  for (const [id, m] of botChannel?.members ?? []) {
    if (id !== member.id && !m.user.bot) otherListeners++;
  }

  return {
    botChannelId: botChannel?.id ?? null,
    memberChannelId: member.voice.channelId,
    otherListeners,
    canBypass
  };
}

export function describeVoiceControlRefusal(action: VoiceAction, botChannelId: string): string {
  const channel = `<#${botChannelId}>`;

  switch (action) {
    case "summon":
      return `I'm in use in ${channel} right now. Join that channel to play sounds, or wait until it's empty.`;
    case "stop":
      return `Only people listening in ${channel} can stop playback.`;
    case "leave":
      return `Only people listening in ${channel} can make me leave.`;
  }
}
