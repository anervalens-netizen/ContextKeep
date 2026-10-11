import { expect, it, vi } from "vitest";
import { transport } from "../src/components/PwaTaskPanel.js";
import { apiFetch } from "../src/lib/api.js";
import { ToolError, describeToolError } from "../src/lib/tool-error.js";
vi.mock("../src/lib/api.js", () => ({ apiFetch: vi.fn(async () => ({})) }));
it("forwards task and dossier selection, view, query and depth", async () => {
  await transport.tasks("p", 20, {
    selection: "all_actions",
    view: "attention",
    q: "two words",
  });
  let url = new URL(
    vi.mocked(apiFetch).mock.calls.at(-1)![0],
    "https://example.test",
  );
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    selection: "all_actions",
    view: "attention",
    q: "two words",
    offset: "20",
  });
  await transport.overview!("p", 10, 20, {
    selection: "all_actions",
    view: "active",
    q: "fixture",
  });
  url = new URL(
    vi.mocked(apiFetch).mock.calls.at(-1)![0],
    "https://example.test",
  );
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    selection: "all_actions",
    view: "active",
    q: "fixture",
    attentionOffset: "20",
  });
  await transport.resume!("p", "t", "deep");
  expect(vi.mocked(apiFetch).mock.calls.at(-1)![0]).toContain("depth=deep");
});
it("keeps safe structured error guidance across MCP and display", () => {
  const marker = "Bearer " + "Z".repeat(25);
  const error = new ToolError({
    code: "stale_revision",
    message: "Refresh revision " + marker,
    retryable: false,
    nextAction: "read_current_revision",
  });
  const text = describeToolError(error, "Cannot prepare context.");
  expect(text).toContain("stale_revision");
  expect(text).toContain("read_current_revision");
  expect(text).toContain("Retryable: false");
  expect(text).not.toContain("Z".repeat(25));
});
it("keeps default recent task pages on the bounded backend route", async () => {
  await transport.tasks("p", 20, {
    selection: "actual_tasks",
    view: "recent",
    q: "fixture",
  });
  const url = new URL(
    vi.mocked(apiFetch).mock.calls.at(-1)![0],
    "https://example.test",
  );
  expect(url.searchParams.has("view")).toBe(false);
  expect(url.searchParams.get("offset")).toBe("20");
  expect(url.searchParams.get("q")).toBe("fixture");
});
it("keeps the unfiltered recent dossier on its bounded backend route", async () => {
  await transport.overview!("p", 10, 20, {
    selection: "actual_tasks",
    view: "recent",
  });
  const url = new URL(
    vi.mocked(apiFetch).mock.calls.at(-1)![0],
    "https://example.test",
  );
  expect(url.searchParams.has("view")).toBe(false);
  expect(url.searchParams.get("offset")).toBe("10");
  expect(url.searchParams.get("attentionOffset")).toBe("20");
});
it("shows uncertain-effect guidance only for an uncertain mutation", () => {
  const read = describeToolError(
    new ToolError({
      code: "temporarily_unavailable",
      message: "Try again",
      retryable: true,
      nextAction: "retry_same_request",
    }),
    "Read failed",
  );
  expect(read).toContain("Retryable: true");
  expect(read).not.toContain("uncertain effects");
  const validation = describeToolError(
    new ToolError({
      code: "invalid_input",
      retryable: false,
      nextAction: "fix_input",
    }),
    "Invalid request",
  );
  expect(validation).not.toContain("uncertain effects");
  const uncertain = describeToolError(
    new ToolError({
      code: "idempotency_outcome_unknown",
      retryable: false,
      nextAction: "reconcile_state_before_retry",
    }),
    "Write result unknown",
  );
  expect(uncertain).toContain("uncertain effects");
});
