import type { ReactNode } from "react";

/**
 * ContextKeep CK monogram — the single in-app source of truth for the brand mark.
 *
 * Geometry is the production mark from the logo kit:
 *   brand/contextkeep-logo-kit/01_Vector/contextkeep-ck-master.svg  (viewBox 0 0 1000 1000)
 *
 * The kit's master uses `currentColor`, so the mark inherits the surrounding text colour
 * (the shell renders it in the ContextKeep teal; the login screen renders it in ink).
 * Use `brand/contextkeep-logo-kit/01_Vector/contextkeep-ck-white.svg` on dark surfaces.
 */
export function CkMark({ className = "h-7 w-7" }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 1000 1000" className={className} aria-hidden="true" focusable="false">
      <g fill="currentColor">
        <path d="M500 220H345C190 220 90 335 90 500S190 780 345 780H500L410 650H345C260 650 215 590 215 500S260 350 345 350H410Z" />
        <path d="M440 500L690 220H850L610 500L850 780H690Z" />
      </g>
    </svg>
  );
}
