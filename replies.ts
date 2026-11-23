// How the bot answers interactions. All replies are ephemeral (only the user who acted sees them).
//
// - Soundboard button presses don't create messages for success: the board's own text line is
//   updated ("Playing airhorn 🔊"), so the status stays visible until the next action and never
//   piles up.
// - Slash commands must get a visible response, so their status replies delete themselves after
//   a short, readable time. Errors stay longer.
import { MessageFlags } from "discord.js";
import type { Interaction } from "discord.js";
import { deleteLater, MAX_MESSAGE_LENGTH, truncate } from "./sound-text.js";

// Both must stay under 15 minutes, after which the interaction token can no longer delete them.
export const STATUS_REPLY_LIFETIME_MS = 10_000;
export const ERROR_REPLY_LIFETIME_MS = 2 * 60_000;

/**
 * Sends a separate ephemeral reply, deleted after lifetimeMs (default: the error lifetime, since
 * most replies are errors); pass null to keep it until the user dismisses it. On a button press
 * this never touches the soundboard message itself.
 */
export async function sendReply(
  interaction: Interaction,
  message: string,
  lifetimeMs: number | null = ERROR_REPLY_LIFETIME_MS
): Promise<void> {
  if (!interaction.isRepliable()) return;

  const content = truncate(message, MAX_MESSAGE_LENGTH);

  try {
    let messageId: string | undefined;

    // Buttons are only ever deferred with deferUpdate, where editReply would overwrite the board.
    if (interaction.deferred && !interaction.replied && !interaction.isMessageComponent()) {
      // Fill in the "thinking..." placeholder from acknowledge().
      await interaction.editReply({ content });
    } else if (interaction.replied || interaction.deferred) {
      messageId = (await interaction.followUp({ content, flags: MessageFlags.Ephemeral })).id;
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }

    if (lifetimeMs !== null) {
      // Ephemeral messages can only be deleted through the interaction webhook, not Message#delete.
      // Without messageId this deletes the interaction's own reply, never the soundboard.
      deleteLater(() => interaction.deleteReply(messageId), lifetimeMs);
    }
  } catch (error) {
    // Typically the interaction expired (not answered within 3s) or was already acknowledged.
    console.error("Failed to reply to interaction:", error);
  }
}

/**
 * Reports a successful action. On a soundboard button it replaces the board's text line;
 * otherwise it sends a short-lived ephemeral reply.
 */
export async function sendStatus(interaction: Interaction, message: string): Promise<void> {
  if (!interaction.isMessageComponent() || interaction.replied) {
    await sendReply(interaction, message, STATUS_REPLY_LIFETIME_MS);
    return;
  }

  const content = truncate(message, MAX_MESSAGE_LENGTH);

  try {
    // Only the text changes; the buttons (and the current page) are left as they are.
    if (interaction.deferred) {
      await interaction.editReply({ content });
    } else {
      await interaction.update({ content });
    }
  } catch (error) {
    console.error("Failed to update the soundboard:", error);
  }
}

/**
 * Acknowledges an interaction that will take a while (joining voice can take seconds), so it
 * doesn't expire. Buttons are acknowledged without a "thinking..." message.
 */
export async function acknowledge(interaction: Interaction): Promise<void> {
  if (!interaction.isRepliable() || interaction.replied || interaction.deferred) return;

  try {
    if (interaction.isMessageComponent()) {
      await interaction.deferUpdate();
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    console.error("Failed to defer interaction:", error);
  }
}
