import { App } from "@slack/bolt";
import * as firestore from "../services/firestore";
import { postEphemeral } from "../services/slack";
import { requireOnboarded } from "../utils/slack";
import { toSlackChannelName } from "../utils/helpers";

export function registerSetShootCommand(app: App): void {
  app.command("/setshoot", async ({ ack, command, respond, client }) => {
    await ack();

    console.log("[SetShoot] command received", {
      userId: command.user_id,
      teamId: command.team_id,
      channelId: command.channel_id,
      channelName: command.channel_name,
      text: command.text,
    });

    const isReady = await requireOnboarded(
      command.user_id,
      command.team_id,
      respond
    );
    if (!isReady) return;

    // 2. DM-only check
    if (command.channel_name !== "directmessage") {
      await respond({
        response_type: "ephemeral",
        text:
        "Please use commands in our DMs. Find me in your sidebar under Direct Messages."
      });
      return;
    }

    // Single placeholder message in the DM that we'll keep updating in-place.
    let placeholderTs: string | undefined;
    const updatePlaceholder = async (text: string, blocks?: any[]) => {
      if (!placeholderTs) {
        const created = await client.chat.postMessage({
          channel: command.channel_id,
          text,
          ...(blocks ? { blocks } : {}),
        });
        placeholderTs = created.ts;
      } else {
        await client.chat.update({
          channel: command.channel_id,
          ts: placeholderTs,
          text,
          ...(blocks ? { blocks } : {}),
        });
      }
    };

    await updatePlaceholder("Setting desired shoot…");

    // 3. Validate input
    if (!command.text?.trim()) {
      await updatePlaceholder(
        "Please provide a shoot name. Example: `/setshoot nike-campaign-march`"
      );
      return;
    }

    const rawName = command.text.trim();
    const normalizedName = toSlackChannelName(rawName);
    if (!normalizedName) {
      await updatePlaceholder(
        "That name isn't valid. Use letters, numbers, hyphens, or underscores."
      );
      return;
    }

    // 5. Find active shoot by name (stored names are sanitized)
    const activeShoots = await firestore.getAllShoots(command.user_id);
    const shoot = activeShoots.find(
      (s) => s.name === normalizedName && s.status === "active"
    );

    if (!shoot) {
      if (activeShoots.length === 0) {
        await updatePlaceholder(
          "You have no active shoots. Run `/newshoot [name]` to create one."
        );
      } else {
        const list = activeShoots.map((s) => `• ${s.name}`).join("\n");
        await updatePlaceholder(
          `No active shoot found with that name. Your active shoots:\n${list}\n\n`
        );
      }
      return;
    }

    // 6. Set as active shoot
    await firestore.setActiveShoot(command.user_id, shoot.id);

    // 7. Final non-ephemeral message with Block Kit
    const blocks = [
      {
        type: "header" as const,
        text: {
          type: "plain_text" as const,
          text: `Active shoot -> ${shoot.name}`,
          emoji: true,
        },
      },
      {
        type: "section" as const,
        text: {
          type: "mrkdwn" as const,
          text: `All expenses you log will go here until you switch again.`,
        },
      },
    ];

    const text = `Active shoot -> ${shoot.name}. All expenses you log will go here until you switch again.`;

    await updatePlaceholder(text, blocks as never);
  });
}
