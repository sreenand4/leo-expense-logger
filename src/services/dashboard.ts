import { WebClient } from "@slack/web-api";
import { getAllShootsIncludingArchived } from "./firestore";

interface DashboardShoot {
  id: string;
  name: string;
  status: "active" | "archived";
  archivedAt: Date | null;
  isSelected: boolean;
}

export function formatDashboardBlocks(shoots: DashboardShoot[]): object[] {
  const activeShoots = shoots.filter((s) => s.status === "active");
  const archivedShoots = shoots
    .filter((s) => s.status === "archived")
    .sort((a, b) => {
      if (!a.archivedAt) return 1;
      if (!b.archivedAt) return -1;
      return b.archivedAt.getTime() - a.archivedAt.getTime();
    });

  const lastUpdated = new Date().toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  const blocks: object[] = [
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
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Last updated: ${lastUpdated}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":vertical_traffic_light: *Active Shoots*",
      },
    },
    { type: "divider" },
  ];

  if (activeShoots.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_No active shoots. Run /newshoot [name] to get started._",
      },
    });
  } else {
    for (const s of activeShoots) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: s.isSelected ? `• ${s.name} ✓` : `• ${s.name}`,
        },
      });
    }
  }

  if (archivedShoots.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":wastebasket: *Archived Shoots*",
      },
    });
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "_Archived shoots will be permanently deleted after 30 days._",
        },
      ],
    });
    for (const s of archivedShoots) {
      const dateStr = s.archivedAt
        ? s.archivedAt.toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : "—";
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `• ${s.name} — wrapped ${dateStr}`,
        },
      });
    }
  }

  return blocks;
}

/** Build dashboard blocks for a user and active shoot, for use in the Home tab. */
export async function buildDashboardBlocks(
  userId: string,
  activeShootId: string | null
): Promise<object[]> {
  const allShoots = await getAllShootsIncludingArchived(userId);
  const mappedShoots: DashboardShoot[] = allShoots.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    archivedAt: s.archivedAt,
    isSelected: s.id === activeShootId,
  }));

  const activeShoots = mappedShoots.filter((s) => s.status === "active");
  const selectedFirst = [
    ...activeShoots.filter((s) => s.isSelected),
    ...activeShoots.filter((s) => !s.isSelected),
  ];
  const archived = mappedShoots
    .filter((s) => s.status === "archived")
    .sort((a, b) => {
      if (!a.archivedAt) return 1;
      if (!b.archivedAt) return -1;
      return b.archivedAt.getTime() - a.archivedAt.getTime();
    });

  const sortedShoots = [...selectedFirst, ...archived];
  return formatDashboardBlocks(sortedShoots);
}
