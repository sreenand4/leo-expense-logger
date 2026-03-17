/**
 * Sanitize to lowercase-hyphenated format for Slack channel name and Firestore shoot name.
 */
export function toSlackChannelName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "");
}
