import { getOrCreateUser } from "../services/firestore";

function getBaseUrl(): string {
  return process.env.SERVER_BASE_URL ?? "";
}

/** Shared connect prompt text, used as fallback alongside blocks. */
export function getConnectGoogleMessage(userId: string): string {
  const baseUrl = getBaseUrl();
  return `Before using Slate, you need to connect your Google account. Open the Slate app and click *Connect Google Account*, or visit: ${baseUrl}/auth/google?userId=${userId}`;
}

/** Shared Block Kit for \"Connect Google\" — matches the Home tab pending_google view. */
export function getConnectGoogleBlocks(
  userId: string
): Array<Record<string, unknown>> {
  const baseUrl = getBaseUrl();
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Hey, I'm Leo!",
        emoji: true,
      },
    },
    {
      type: "divider",
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Here to help you log expenses for your shoots right from Slack. DM me receipt photos, quick transaction entries (Uber $35), or ask about your spending summaries!",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Before you can start, connect your Google Drive so Leo can create and manage your expense sheets.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Continue with Google",
            emoji: true,
          },
          style: "primary",
          action_id: "connect_google",
          url: `${baseUrl}/auth/google?userId=${userId}`,
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "You will be redirected to auth.google.com to authorize access.",
        },
      ],
    },
  ];
}

export async function requireOnboarded(
  userId: string,
  workspaceId: string | undefined,
  // Deliberately loose typing here so we can pass Bolt's RespondFn without importing its types.
  respond: (message: any) => Promise<void>
): Promise<boolean> {
  const user = await getOrCreateUser(userId, userId, workspaceId);

  if (user.onboardingStatus !== "ready") {
    await respond({
      response_type: "ephemeral",
      text: getConnectGoogleMessage(userId),
      blocks: getConnectGoogleBlocks(userId),
    });
    return false;
  }

  return true;
}
