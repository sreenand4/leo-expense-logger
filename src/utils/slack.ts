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
        text: "📋 Slate",
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Welcome to Slate — your shoot expense logger.\n\nSlate helps you log expenses for every shoot, right from Slack. Receipt photos, quick text entries, spending summaries — all in your DMs.",
      },
    },
    {
      type: "divider",
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Before you can start, connect your Google account.*\nSlate needs access to Google Drive and Sheets to create and manage your expense sheets.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "🔗 Connect Google Account",
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
          text: "You will be redirected to Google to authorize access. Slate only requests Drive and Sheets permissions.",
        },
      ],
    },
  ];
}

export async function requireOnboarded(
  userId: string,
  // Deliberately loose typing here so we can pass Bolt's RespondFn without importing its types.
  respond: (message: any) => Promise<void>
): Promise<boolean> {
  const user = await getOrCreateUser(userId, userId);

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
