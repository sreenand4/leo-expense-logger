import { App, AnyBlock } from "@slack/bolt";
import { getOrCreateUser } from "../services/firestore";
import { buildDashboardBlocks } from "../services/dashboard";
import { getConnectGoogleBlocks } from "../utils/slack";

export function registerAppHomeHandler(app: App): void {
  app.event("app_home_opened", async ({ event, client, logger, context }) => {
    try {
      const userId = event.user;
      // Use Slack profile info for a nicer display name when we first see the user.
      const info = await client.users.info({ user: userId });
      const profile = info.user?.profile;
      const displayName =
        profile?.display_name ||
        profile?.real_name ||
        userId;

      const user = await getOrCreateUser(userId, displayName, context.teamId);

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
            blocks: dashboardBlocks as AnyBlock[],
          },
        });
      }
    } catch (err) {
      logger.error(err);
    }
  });
}
