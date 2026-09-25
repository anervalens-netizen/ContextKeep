import type { ReactNode } from "react";

export type IconName =
  | "projects"
  | "inbox"
  | "import"
  | "correct"
  | "search"
  | "activity"
  | "archive"
  | "branch"
  | "clock"
  | "database"
  | "sparkles"
  | "arrow-left"
  | "chevron-right"
  | "plus"
  | "download"
  | "more"
  | "menu"
  | "chat"
  | "settings"
  | "close"
  | "panel-left"
  | "panel-right";

const paths: Record<IconName, ReactNode> = {
  projects: <><rect x="3" y="4" width="7" height="7" rx="2"/><rect x="14" y="4" width="7" height="7" rx="2"/><rect x="3" y="15" width="7" height="5" rx="2"/><rect x="14" y="15" width="7" height="5" rx="2"/></>,
  inbox: <><path d="M4 5h16v11H4z"/><path d="M4 13h4l2 3h4l2-3h4"/></>,
  import: <><path d="M12 3v12"/><path d="m8 11 4 4 4-4"/><path d="M5 19h14"/></>,
  correct: <><path d="M4 20h4l11-11-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
  activity: <path d="M3 12h4l2.2-5 4 10 2.2-5H21"/>,
  archive: <><path d="M4 8h16v12H4z"/><path d="M3 4h18v4H3z"/><path d="M9 12h6"/></>,
  branch: <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10"/><path d="M8 9h4a6 6 0 0 0 6-1"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></>,
  sparkles: <><path d="m12 3 1.2 3.3L16.5 7.5l-3.3 1.2L12 12l-1.2-3.3-3.3-1.2 3.3-1.2z"/><path d="m18 13 .8 2.2L21 16l-2.2.8L18 19l-.8-2.2L15 16l2.2-.8z"/><path d="m5 14 .7 1.8 1.8.7-1.8.7L5 19l-.7-1.8-1.8-.7 1.8-.7z"/></>,
  "arrow-left": <><path d="m15 18-6-6 6-6"/><path d="M9 12h11"/></>,
  "chevron-right": <path d="m9 18 6-6-6-6"/>,
  plus: <><path d="M12 5v14"/><path d="M5 12h14"/></>,
  download: <><path d="M12 4v11"/><path d="m8 11 4 4 4-4"/><path d="M5 20h14"/></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/></>,
  menu: <><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/></>,
  chat: <><path d="M5 5h14v10H9l-4 4z"/><path d="M8 9h8"/><path d="M8 12h5"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7a6 6 0 0 0-.6-1.4l.9-1.9-2.1-2.1-1.9.9a6 6 0 0 0-1.4-.6L11.2 2h-3l-.7 2.7a6 6 0 0 0-1.4.6l-1.9-.9-2.1 2.1.9 1.9a6 6 0 0 0-.6 1.4l-2 .7v3l2 .7a6 6 0 0 0 .6 1.4l-.9 1.9 2.1 2.1 1.9-.9a6 6 0 0 0 1.4.6l.7 2.7h3l.7-2.7a6 6 0 0 0 1.4-.6l1.9.9 2.1-2.1-.9-1.9a6 6 0 0 0 .6-1.4z" transform="scale(.75) translate(4 4)"/></>,
  close: <><path d="m6 6 12 12"/><path d="m18 6-12 12"/></>,
  "panel-left": <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="m14 9-3 3 3 3"/></>,
  "panel-right": <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="m10 9 3 3-3 3"/></>,
};

export function Icon({ name, className = "h-5 w-5" }: { name: IconName; className?: string }): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
