/** A bot's incognito threads, from the `incognitoThreadIds` field on WireBot. */
export function incognitoThreadIdsOf(bot: unknown): ReadonlySet<string> {
  if (typeof bot !== "object" || bot === null) return new Set();
  const ids = (bot as { incognitoThreadIds?: unknown }).incognitoThreadIds;
  return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
}

export function isIncognitoThread(bot: unknown, threadId: string): boolean {
  return incognitoThreadIdsOf(bot).has(threadId);
}
