/** Schedule read-only refreshes. Callers coalesce against manual reads and paging. */
export function schedulePanelRefresh(
  refresh: () => void,
  intervalMs: number | null,
) {
  if (intervalMs === null) return () => {};
  const visible = () => {
    if (document.visibilityState !== "hidden") refresh();
  };
  const timer = setInterval(visible, Math.max(15000, intervalMs));
  document.addEventListener("visibilitychange", visible);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", visible);
  };
}
