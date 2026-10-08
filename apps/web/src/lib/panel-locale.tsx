import { createContext, useContext } from "react";
import messages from "./panel-translations.json";
export const PanelLocale = createContext<"ro" | "en" | undefined>(undefined);
export function translatePanel(
  language: "ro" | "en" | undefined,
  text: string,
): string {
  if (!language) return text;
  const key = text.replace(/\s+/g, " ").trim();
  const entry = (messages as Record<string, { ro: string; en: string }>)[key];
  if (!entry) return text;
  return (
    (text.startsWith(" ") ? " " : "") +
    entry[language] +
    (text.endsWith(" ") ? " " : "")
  );
}
export function usePanelText() {
  const language = useContext(PanelLocale);
  return (text: string) => translatePanel(language, text);
}
