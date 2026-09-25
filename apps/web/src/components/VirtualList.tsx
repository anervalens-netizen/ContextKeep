import { useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

/**
 * TanStack Virtual wrapper for the long lists (review inbox, timeline, search
 * results) — handoff §9: 1,000-row lists stay inside the 16ms frame budget.
 */
export function VirtualList<T>({
  items,
  estimateRowHeight,
  renderRow,
  emptyText = "Nothing here yet.",
  overscan = 8,
}: {
  items: T[];
  estimateRowHeight: number;
  renderRow: (item: T, index: number) => ReactNode;
  emptyText?: string;
  overscan?: number;
}): ReactNode {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateRowHeight,
    overscan,
  });

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-ck-line bg-ck-surface p-4 text-sm text-ck-muted">{emptyText}</div>
    );
  }

  return (
    <div ref={parentRef} className="max-h-[70vh] overflow-auto rounded-xl border border-ck-line bg-ck-surface">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((v) => (
          <div
            key={v.key}
            data-index={v.index}
            ref={virtualizer.measureElement}
            style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${v.start}px)` }}
          >
            {renderRow(items[v.index]!, v.index)}
          </div>
        ))}
      </div>
    </div>
  );
}
