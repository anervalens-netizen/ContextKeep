import { describe, it, expect, vi } from "vitest";
import { PanelDisplay } from "../src/lib/panel-display.js";
describe("one-shot supported fullscreen", () => {
  it("waits for support and never requests a mode that is already active", async () => {
    const display = new PanelDisplay(),
      request = vi.fn(async () => ({ mode: "fullscreen" }));
    await display.requestFullscreen(undefined, request);
    await display.requestFullscreen(
      { availableDisplayModes: ["inline"] },
      request,
    );
    await display.requestFullscreen(
      { displayMode: "fullscreen", availableDisplayModes: ["fullscreen"] },
      request,
    );
    expect(request).not.toHaveBeenCalled();
    await display.requestFullscreen(
      { displayMode: "inline", availableDisplayModes: ["fullscreen"] },
      request,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("does not retry rejection or reinterpret the host's inline fallback as fullscreen", async () => {
    for (const request of [
      vi.fn(async () => {
        throw new Error("declined");
      }),
      vi.fn(async () => ({ mode: "inline" })),
    ]) {
      const display = new PanelDisplay(),
        context = {
          displayMode: "inline",
          availableDisplayModes: ["fullscreen"],
        };
      const first = await display.requestFullscreen(context, request);
      expect(first).not.toBe("fullscreen");
      await display.requestFullscreen(context, request);
      expect(request).toHaveBeenCalledTimes(1);
    }
  });
});
