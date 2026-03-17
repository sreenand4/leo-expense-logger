import { App } from "@slack/bolt";
import * as firestore from "../services/firestore";
import * as sheets from "../services/sheets";
import { archiveChannel, postEphemeral, postToChannel } from "../services/slack";
import { requireOnboarded } from "../utils/slack";

function isArchiveNonFatalError(err: unknown): boolean {
  const dataError = (err as { data?: { error?: string } })?.data?.error;
  const message = (err as Error)?.message ?? "";
  const code = dataError ?? message;
  return code === "already_archived" || code === "channel_not_found";
}

function buildSummaryBlocks(
  shootName: string,
  expenses: { amount: number; category: string }[],
  sheetUrl: string
): { blocks: Record<string, unknown>[]; text: string } {
  const grandTotal = expenses.reduce((sum, e) => sum + e.amount, 0);
  const totalsByCategory: Record<string, number> = {};
  for (const e of expenses) {
    const cat = e.category?.trim() || "Uncategorized";
    totalsByCategory[cat] = (totalsByCategory[cat] ?? 0) + e.amount;
  }
  const categoryLines = Object.entries(totalsByCategory)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cat, total]) => `  ${cat}     $${total.toFixed(2)}`)
    .join("\n");

  const hasExpenses = expenses.length > 0;
  const breakdownSection =
    hasExpenses && categoryLines
      ? `By category:\n${categoryLines}`
      : "No expenses were logged for this shoot.";

  const blocks = [
    {
      type: "header" as const,
      text: {
        type: "plain_text" as const,
        text: `🎬 ${shootName} — Wrapped ✅`,
        emoji: true,
      },
    },
    {
      type: "section" as const,
      text: {
        type: "mrkdwn" as const,
        text: `💰 *Total:* $${grandTotal.toFixed(2)}\n📋 *${expenses.length}* expense${expenses.length === 1 ? "" : "s"} logged`,
      },
    },
    {
      type: "section" as const,
      text: {
        type: "mrkdwn" as const,
        text: breakdownSection,
      },
    },
    {
      type: "section" as const,
      text: {
        type: "mrkdwn" as const,
        text: `📄 Full Sheet: <${sheetUrl}|Open sheet>`,
      },
    },
    {
      type: "context" as const,
      elements: [
        {
          type: "mrkdwn" as const,
          text: "Ready for the next one? Run /newshoot [name] to start a new shoot.",
        },
      ],
    },
  ];

  const text = `🎬 ${shootName} — Wrapped ✅. Total: $${grandTotal.toFixed(2)}. ${expenses.length} expenses. ${sheetUrl}`;
  return { blocks, text };
}

export function registerWrapShootCommand(app: App): void {
  // ----- /wrapshoot slash command: post confirmation with buttons -----
  app.command("/wrapshoot", async ({ ack, command, respond }) => {
    await ack();

    const isReady = await requireOnboarded(command.user_id, respond);
    if (!isReady) return;

    if (command.channel_name !== "directmessage") {
      await postEphemeral(
        command.channel_id,
        command.user_id,
        "Please use Slate commands from our DM."
      );
      return;
    }

    const shoot = await firestore.getActiveShoot(command.user_id);
    if (!shoot) {
      await postEphemeral(
        command.channel_id,
        command.user_id,
        "You don't have an active shoot. Use /newshoot [name] to start one."
      );
      return;
    }

    const confirmBlocks = [
      {
        type: "header" as const,
        text: {
          type: "plain_text" as const,
          text: `🎬 Wrap up "${shoot.name}"?`,
          emoji: true,
        },
      },
      {
        type: "section" as const,
        text: {
          type: "mrkdwn" as const,
          text:
            "This will:\n" +
            "  • Archive the Slack channel\n" +
            "  • Lock the expense sheet\n" +
            "  • Clear your active shoot\n\n" +
            "⚠️ This is irreversible. Archived channels will be deleted in 30 days.",
        },
      },
      {
        type: "actions" as const,
        block_id: "wrapshoot_actions",
        elements: [
          {
            type: "button" as const,
            text: {
              type: "plain_text" as const,
              text: "✅ Yes, wrap it",
              emoji: true,
            },
            action_id: "wrapshoot_confirm",
            value: `wrapshoot_confirm:${shoot.id}`,
          },
          {
            type: "button" as const,
            text: {
              type: "plain_text" as const,
              text: "❌ Cancel",
              emoji: true,
            },
            action_id: "wrapshoot_cancel",
            value: `wrapshoot_cancel:${shoot.id}`,
          },
        ],
      },
    ];

    const confirmText = `Wrap up "${shoot.name}"? This will archive the channel, lock the sheet, and clear your active shoot.`;
    await postToChannel(command.channel_id, confirmBlocks, confirmText);
  });

  // ----- Cancel button: update message, remove buttons -----
  app.action("wrapshoot_cancel", async ({ ack, action, body, client }) => {
    await ack();
    const value = (action as { value?: string }).value ?? "";
    const shootId = value.startsWith("wrapshoot_cancel:")
      ? value.slice("wrapshoot_cancel:".length)
      : "";
    if (!shootId) return;

    const shoot = await firestore.getShoot(shootId);
    const shootName = shoot?.name ?? "This shoot";

    const msg = (body as { message?: { channel?: string; ts?: string }; channel?: { id?: string } }).message;
    const channel = msg?.channel ?? (body as { channel?: { id?: string } }).channel?.id;
    const ts = msg?.ts;
    if (!channel || !ts) return;

    await client.chat.update({
      channel,
      ts,
      text: `Got it, no changes made. ${shootName} is still active.`,
      blocks: [
        {
          type: "section" as const,
          text: {
            type: "mrkdwn" as const,
            text: `Got it, no changes made. *${shootName}* is still active.`,
          },
        },
      ],
    });
  });

  // ----- Yes button: execute wrap -----
  app.action("wrapshoot_confirm", async ({ ack, action, body, client, logger }) => {
    await ack();
    const value = (action as { value?: string }).value ?? "";
    const shootId = value.startsWith("wrapshoot_confirm:")
      ? value.slice("wrapshoot_confirm:".length)
      : "";
    const userId = body.user?.id ?? "";
    if (!shootId || !userId) return;

    const shoot = await firestore.getShoot(shootId);
    if (!shoot || shoot.userId !== userId) {
      const b = body as { message?: { channel?: string; ts?: string }; channel?: { id?: string } };
      const ch = b.message?.channel ?? b.channel?.id;
      const t = b.message?.ts;
      if (ch && t) {
        await client.chat.update({
          channel: ch,
          ts: t,
          text: "Something went wrong (shoot not found). Please try again.",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "Something went wrong (shoot not found). Please try again.",
              },
            },
          ],
        });
      }
      return;
    }

    const msg = (body as { message?: { channel?: string; ts?: string }; channel?: { id?: string } }).message;
    const channel = msg?.channel ?? (body as { channel?: { id?: string } }).channel?.id;
    const ts = msg?.ts;
    if (!channel || !ts) return;

    // Hourglass + remove buttons
    await client.chat.update({
      channel,
      ts,
      text: `:hourglass_flowing_sand: Wrapping up ${shoot.name}...`,
      blocks: [
        {
          type: "section" as const,
          text: {
            type: "mrkdwn" as const,
            text: `:hourglass_flowing_sand: Wrapping up *${shoot.name}*...`,
          },
        },
      ],
    });

    let expenses: { amount: number; category: string }[];
    try {
      expenses = await sheets.getSheetSummary(userId, shoot.googleSheetId);
    } catch (err) {
      logger.error(err);
      await client.chat.update({
        channel,
        ts,
        text: "Something went wrong during the wrap. Please try again or contact support.",
        blocks: [
          {
            type: "section" as const,
            text: {
              type: "mrkdwn" as const,
              text: "Something went wrong during the wrap. Please try again or contact support.",
            },
          },
        ],
      });
      return;
    }

    const sheetUrl = `https://docs.google.com/spreadsheets/d/${shoot.googleSheetId}/edit`;
    const { blocks: summaryBlocks, text: summaryText } = buildSummaryBlocks(
      shoot.name,
      expenses,
      sheetUrl
    );

    // Post farewell to shoot's Slack channel
    try {
      await postToChannel(shoot.slackChannelId, summaryBlocks, summaryText);
    } catch (postErr) {
      logger.warn("Failed to post farewell to shoot channel:", postErr);
    }

    // Archive channel (best-effort)
    try {
      await archiveChannel(shoot.slackChannelId);
    } catch (err) {
      logger.error("Archive channel failed:", err);
      // Continue anyway
    }

    // Firestore: archive shoot and clear active
    await firestore.archiveShoot(shoot.id, userId);

    // Update DM with final summary
    await client.chat.update({
      channel,
      ts,
      text: summaryText,
      blocks: summaryBlocks as never,
    });
  });
}

