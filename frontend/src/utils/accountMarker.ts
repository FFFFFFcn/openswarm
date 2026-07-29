/**
 * Account binding is passed to the agent team by appending a marker line to
 * the outbound user message: `[当前账号: 名称 | account_id=xxx]`. The leader
 * prompt parses it to route account-scoped tasks. The marker is only added to
 * the text sent to the backend — the locally displayed / archived message text
 * stays clean — but `stripAccountMarker` is applied defensively on render so a
 * marker can never leak into the UI (e.g. from older archives or replays).
 */
const ACCOUNT_MARKER_RE = /\n*\[当前账号:[^\n\]]*\][ \t]*$/;

/** Build the marker line for a selected account. */
export function buildAccountMarker(name: string, id: string): string {
  return `[当前账号: ${name} | account_id=${id}]`;
}

/** Append the account marker to an outbound message (backend copy only). */
export function withAccountMarker(text: string, account: { id: string; name: string } | null): string {
  if (!account) return text;
  const marker = buildAccountMarker(account.name, account.id);
  return text ? `${text}\n${marker}` : marker;
}

/** Remove a trailing account marker line from a message for display. */
export function stripAccountMarker(text: string): string {
  return text.replace(ACCOUNT_MARKER_RE, "");
}
