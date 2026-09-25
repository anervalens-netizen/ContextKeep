export interface ChangelogEntry {
  version: string;
  date: string;
  notes: string[];
}

/** Shown in the update prompt and under Menu → Changelog (handoff §14). */
export const changelog: ChangelogEntry[] = [
  {
    version: "Read contracts",
    date: "2026-09-24",
    notes: [
      "Recent captures always have visible titles; copied context retains offline provenance across navigation.",
      "Search exposes result limits and preserves the selected project; current-state counts explain omissions.",
      "Memory attention links and read-only offline conflict details lead to the affected area without replaying changes.",
      "Production database durability defaults to FULL; restores validate a staged copy before replacing existing data.",
    ],
  },
  {
    version: "0.1.1 (L6)",
    date: "2026-09-18",
    notes: [
      "Active projects now stay visible at the top of Projects and in the left sidebar.",
      "Planned, paused, unknown and retired projects are collapsed under an on-demand Other/Inactive section.",
      "PWA install is offered immediately when the browser exposes its native install prompt, including a mobile-header shortcut.",
      "Private Tailscale HTTPS remains the supported phone-install path; browser Add to Home Screen remains the fallback.",
    ],
  },
  {
    version: "0.1.0 (M0)",
    date: "2026-09-09",
    notes: [
      "First milestone: manual import with duplicate detection, review inbox with bulk accept/edit/reject.",
      "Current project brief + historical timeline with evidence links.",
      "Owner corrections with supersession workflow (retired projects stay retired against imports).",
      "Portable Markdown handoff export + full JSON dump.",
      "Offline PWA shell: cached brief/inbox/search and an IndexedDB mutation queue with conflict banners.",
      "Local backup + independently tested restore.",
    ],
  },
];
