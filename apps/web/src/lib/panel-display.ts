type DisplayContext = {
  displayMode?: string;
  availableDisplayModes?: string[];
};
/** A host may deny fullscreen. Never loop or block the usable inline panel. */
export class PanelDisplay {
  private attempted = false;
  async requestFullscreen(
    context: DisplayContext | undefined,
    request: () => Promise<{ mode: string }>,
  ) {
    if (
      this.attempted ||
      context?.displayMode === "fullscreen" ||
      !context?.availableDisplayModes?.includes("fullscreen")
    )
      return;
    this.attempted = true;
    try {
      return (await request()).mode;
    } catch {
      return undefined;
    }
  }
}
