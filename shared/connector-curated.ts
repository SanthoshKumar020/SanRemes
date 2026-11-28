/** The Composio apps Connected apps lists when the catalog cannot be read. Product analytics names these apps, and only these. */
export const CURATED_CONNECTOR_SLUGS = [
  "slack", "github", "gmail", "googlecalendar", "googlesheets", "googledocs", "googledrive", "notion", "linear", "sentry",
  "posthog", "discord", "twitter", "reddit", "zapier", "hubspot", "salesforce", "jira", "asana", "trello", "dropbox",
  "airtable", "figma", "stripe", "outlook", "one_drive", "share_point", "microsoft_teams",
] as const;

export type CuratedConnectorSlug = (typeof CURATED_CONNECTOR_SLUGS)[number];

/** The Microsoft 365 apps among the curated connectors. Teams and SharePoint need a work or school Microsoft account;
 * Outlook and OneDrive also work with a personal one. */
export const MICROSOFT_365_CONNECTOR_SLUGS = ["outlook", "one_drive", "share_point", "microsoft_teams"] as const;

export type Microsoft365ConnectorSlug = (typeof MICROSOFT_365_CONNECTOR_SLUGS)[number];
