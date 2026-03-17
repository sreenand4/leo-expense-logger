import { App, AnyBlock } from "@slack/bolt";
import { getOrCreateUser } from "../services/firestore";
import { buildDashboardBlocks } from "../services/dashboard";
import { getConnectGoogleBlocks } from "../utils/slack";

export function registerAppHomeHandler(app: App): void {
  app.event("app_home_opened", async ({ event, client, logger }) => {
    try {
      const userId = event.user;
      const user = await getOrCreateUser(userId, userId);

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
                  text: "📋 Slate",
                  emoji: true,
                },
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "*Welcome back!* DM Slate to log expenses or ask about your spending.",
                },
              },
              {
                type: "divider",
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "*Available Commands*",
                },
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "`/newshoot [name]` — Start a new shoot\n`/setshoot [name]` — Switch active shoot\n`/wrapshoot` — Wrap up and archive a shoot\n`/help` — Show all commands",
                },
              },
              {
                type: "divider",
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: '*How to log expenses*\nJust DM Slate:\n• _"Uber $45"_\n• _"Lunch with client $32"_\n• Drop a receipt photo',
                },
              },
              {
                type: "context",
                elements: [
                  {
                    type: "mrkdwn",
                    text: "Google account connected ✓",
                  },
                ],
              },
              {
                type: "divider",
              },
              ...dashboardBlocks,
            ],
          },
        });
      }
    } catch (err) {
      logger.error(err);
    }
  });
}
