import { getOrCreateUser } from "../services/firestore";

type OnboardingStatus = "pending_google" | "ready";

interface CachedUserState {
  onboardingStatus: OnboardingStatus;
  googleRefreshToken: string | null;
}

const userStateCache = new Map<string, CachedUserState>();

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
        text: "I'm a Slack based expense logging AI assistant built for freelance photographers. DM me \"Uber $45\" or drop a receipt photo, and I'll handle the rest. Leo reads it, categorizes it, and saves it to a dedicated Google Sheet for every shoot. Built for photographers who'd rather be shooting than doing admin.",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Before you can start, connect your Google Drive so Leo can create and manage your expense sheets.",
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

/**
 * Lightweight cached wrapper around getOrCreateUser for onboarding checks.
 * Caches only onboardingStatus and googleRefreshToken by userId.
 */
export async function getUserStateWithCache(
  userId: string,
  displayName: string,
  workspaceId?: string
): Promise<CachedUserState> {
  const cached = userStateCache.get(userId);
  if (cached) {
    return cached;
  }

  const user = await getOrCreateUser(userId, displayName, workspaceId);
  const state: CachedUserState = {
    onboardingStatus: user.onboardingStatus,
    googleRefreshToken: user.googleRefreshToken,
  };
  userStateCache.set(userId, state);
  return state;
}

export async function requireOnboarded(
  userId: string,
  workspaceId: string | undefined,
  // Deliberately loose typing here so we can pass Bolt's RespondFn without importing its types.
  respond: (message: any) => Promise<void>
): Promise<boolean> {
  const { onboardingStatus } = await getUserStateWithCache(
    userId,
    userId,
    workspaceId
  );

  if (onboardingStatus !== "ready") {
    await respond({
      response_type: "ephemeral",
      text: getConnectGoogleMessage(userId),
      blocks: getConnectGoogleBlocks(userId),
    });
    return false;
  }

  return true;
}
