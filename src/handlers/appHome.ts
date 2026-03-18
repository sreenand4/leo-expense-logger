import { App, AnyBlock } from "@slack/bolt";
import { getOrCreateUser } from "../services/firestore";
import { buildDashboardBlocks } from "../services/dashboard";
import { getConnectGoogleBlocks } from "../utils/slack";

export function registerAppHomeHandler(app: App): void {
  app.event("app_home_opened", async ({ event, client, logger, context }) => {
    try {
      const userId = event.user;
      const user = await getOrCreateUser(userId, userId, context.teamId);

      if (user.onboardingStatus === "pending_google") {
        await client.views.publish({
          user_id: userId,
          view: {
            type: "home",
            blocks: getConnectGoogleBlocks(userId) as unknown as AnyBlock[],
          },
        });
      } else {
        const dashboardBlocks = (await buildDashboardBlocks(
          userId,
          user.activeShootId
        )) as unknown as AnyBlock[];
        await client.views.publish({
          user_id: userId,
          view: {
            type: "home",
            blocks: [
              {
                type: "header",
                text: {
                  type: "plain_text",
                  text: "Leo’s Dashboard",
                  emoji: true,
                },
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "Google account connected ✓",
                },
              },
              {
                type: "divider",
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `Last updated: ${new Date().toLocaleString("en-US", {
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}`,
                },
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "🚦 *Active Shoots*",
                },
              },
              {
                type: "divider",
              },
              ...dashboardBlocks,
              {
                type: "divider",
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "🗑️ *Archived Shoots*",
                },
              },
              {
                type: "context",
                elements: [
                  {
                    type: "mrkdwn",
                    text: "_Archived shoots will be permanently deleted after 30 days._",
                  },
                ],
              },
            ],
          },
        });
      }
    } catch (err) {
      logger.error(err);
    }
  });
}
