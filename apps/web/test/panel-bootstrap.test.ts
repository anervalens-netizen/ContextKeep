import { DEFAULT_PANEL_PREFERENCES } from "@contextkeep/shared";
import { describe, it, expect, vi } from "vitest";
import { PanelBootstrap } from "../src/lib/panel-bootstrap.js";
describe("initial panel projection", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const args = { projectId: "project", taskId: "task", offset: 0, limit: 20 };
  const prime = () => ({
    version: 1,
    observedAt: new Date(now).toISOString(),
    reads: [
      {
        tool: "get_task",
        arguments: args,
        value: { task: { id: "task", revision: 3 } },
      },
    ],
  });
  it("hydrates matching concurrent readers without duplicate fetch and refetches subsequent refreshes", async () => {
    const cache = new PanelBootstrap();
    cache.prime(prime(), now);
    const fetcher = vi.fn(async () => ({ task: { id: "task", revision: 4 } }));
    const [first, second] = await Promise.all([
      cache.read("get_task", args, fetcher, now),
      cache.read("get_task", { ...args }, fetcher, now),
    ]);
    expect(first).toEqual(second);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await cache.read("get_task", args, fetcher, now)).task).toEqual({
      id: "task",
      revision: 4,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not reuse expired, future, wrong-task or wrong-page projections", async () => {
    for (const time of [now - 31000, now + 6000]) {
      const cache = new PanelBootstrap();
      cache.prime(
        { ...prime(), observedAt: new Date(time).toISOString() },
        now,
      );
      const fetcher = vi.fn(async () => ({ fresh: true }));
      expect(await cache.read("get_task", args, fetcher, now)).toEqual({
        fresh: true,
      });
    }
    const cache = new PanelBootstrap();
    cache.prime(prime(), now);
    const fetcher = vi.fn(async () => ({ fresh: true }));
    await cache.read("get_task", { ...args, taskId: "other" }, fetcher, now);
    await cache.read("get_task", { ...args, offset: 20 }, fetcher, now);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not seed write tools and retries after a rejected coalesced read", async () => {
    const cache = new PanelBootstrap();
    cache.prime(
      {
        version: 1,
        observedAt: new Date(now).toISOString(),
        reads: [
          { tool: "settings.update", arguments: {}, value: { fake: true } },
        ],
      },
      now,
    );
    const write = vi.fn(async () => ({ real: true }));
    expect(await cache.read("settings.update", {}, write, now)).toEqual({
      real: true,
    });
    const fail = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(cache.read("get_task", args, fail, now)).rejects.toThrow(
      "offline",
    );
    await expect(cache.read("get_task", args, fail, now)).rejects.toThrow(
      "offline",
    );
    expect(fail).toHaveBeenCalledTimes(2);
  });
  it("validates saved preferences and clears them when the next projection is stale", () => {
    const cache = new PanelBootstrap();
    cache.prime(
      {
        ...prime(),
        preferences: {
          ...DEFAULT_PANEL_PREFERENCES,
          refreshInterval: "manual",
          taskVisibility: "all_actions",
        },
      },
      now,
    );
    expect(cache.preferences?.refreshInterval).toBe("manual");
    expect(cache.preferences?.taskVisibility).toBe("all_actions");
    cache.prime(
      {
        ...prime(),
        preferences: { ...DEFAULT_PANEL_PREFERENCES, refreshInterval: "1ms" },
      },
      now,
    );
    expect(cache.preferences).toBeUndefined();
    cache.prime({ ...prime(), preferences: DEFAULT_PANEL_PREFERENCES }, now);
    cache.prime(
      {
        ...prime(),
        observedAt: new Date(now - 31000).toISOString(),
        preferences: DEFAULT_PANEL_PREFERENCES,
      },
      now,
    );
    expect(cache.preferences).toBeUndefined();
  });
  it("reads saved preferences after a stale bootstrap, rejects invalid settings and ignores an old response", async () => {
    const cache = new PanelBootstrap();
    cache.prime(
      { ...prime(), observedAt: new Date(now - 31000).toISOString() },
      now,
    );
    await cache.loadPreferences(async () => ({
      values: { ...DEFAULT_PANEL_PREFERENCES, refreshInterval: "manual" },
    }));
    expect(cache.preferences?.refreshInterval).toBe("manual");
    await expect(
      cache.loadPreferences(async () => ({ values: {} })),
    ).rejects.toThrow();
    let finish!: (v: { values: unknown }) => void;
    const old = cache.loadPreferences(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    cache.prime(
      {
        ...prime(),
        preferences: { ...DEFAULT_PANEL_PREFERENCES, refreshInterval: "120s" },
      },
      now,
    );
    finish({ values: DEFAULT_PANEL_PREFERENCES });
    expect(await old).toBe(false);
    expect(cache.preferences?.refreshInterval).toBe("120s");
  });
  it("does not join an old in-flight read after a new opener projection", async () => {
    const cache = new PanelBootstrap();
    let resolve!: (value: Record<string, unknown>) => void;
    const old = cache.read(
      "get_task",
      args,
      () =>
        new Promise((r) => {
          resolve = r;
        }),
      now,
    );
    cache.prime(prime(), now);
    const fetcher = vi.fn(async () => ({}));
    expect((await cache.read("get_task", args, fetcher, now)).task).toEqual({
      id: "task",
      revision: 3,
    });
    expect(fetcher).not.toHaveBeenCalled();
    resolve({ old: true });
    await old;
  });
});
