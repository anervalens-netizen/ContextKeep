import { useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuthStatusDto } from "@contextkeep/shared";
import { apiFetch, ApiError, setPrivateReadsPausedForAuthTransition } from "../lib/api.js";
import { currentInstallGate } from "../lib/install-gate.js";
import { CkMark } from "../components/CkMark.js";
import { RETRY_OFFLINE_QUEUE_EVENT } from "../lib/idempotency-key.js";

export default function Login(): ReactNode {
  const queryClient = useQueryClient();
  const auth = useQuery({
    queryKey: ["auth-status"],
    queryFn: () => apiFetch<AuthStatusDto>("/api/auth/status", { noQueue: true }),
    retry: false,
  });
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const needsSetup = auth.data?.needsSetup === true;
  const gate = currentInstallGate();

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const url = needsSetup ? "/api/auth/setup" : "/api/auth/login";
      await apiFetch<{ ok: boolean }>(url, { method: "POST", body: { password }, noQueue: true });
      setPrivateReadsPausedForAuthTransition(false);
      setPassword("");
      await queryClient.invalidateQueries({ queryKey: ["auth-status"] });
      void queryClient.invalidateQueries();
      // F07: the apiFetch 401 path preserves staged mutations so they can
      // resume after re-authentication. Without an explicit resume signal
      // those rows would sit idle until the next reload or `online` event.
      // Dispatch the shared retry event so main.tsx's normal queue sync
      // path replays them in order using the original idempotency keys.
      // Failed logins do NOT reach this line — they throw before here.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(RETRY_OFFLINE_QUEUE_EVENT));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Authentication failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto mt-8 max-w-sm">
      <div className="flex flex-col items-center gap-2 text-ck-teal">
        <CkMark className="h-12 w-12" />
        <h1 className="text-lg font-semibold text-ck-ink">ContextKeep</h1>
        <p className="text-xs text-ck-muted">Keep the context. Know what changed.</p>
      </div>

      {!gate.allowed ? (
        <div className="mt-4 rounded-xl border border-ck-amber/40 bg-ck-amber/10 p-3 text-xs text-ck-amber">
          <p className="font-semibold">Install refused (A16)</p>
          <p className="mt-1">{gate.reason}</p>
        </div>
      ) : null}

      <form onSubmit={(e) => void submit(e)} className="mt-6 rounded-2xl border border-ck-line bg-ck-surface p-4">
        <h2 className="text-sm font-semibold">
          {auth.isLoading ? "Loading…" : needsSetup ? "First-run setup" : "Owner sign in"}
        </h2>
        <p className="mt-1 text-xs text-ck-muted">
          {needsSetup
            ? "Choose the local owner password. It is stored hashed (scrypt) on this machine only — no external identity provider."
            : "Single-user, owner-only access. Sessions use a Secure/HttpOnly cookie with CSRF protection."}
        </p>
        <input
          type="password"
            aria-label="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete={needsSetup ? "new-password" : "current-password"}
          className="mt-3 w-full rounded-xl border border-ck-line bg-ck-bg px-3 py-2 text-sm outline-none focus:border-ck-teal"
          required
          minLength={needsSetup ? 8 : undefined}
        />
        {error ? <p className="mt-2 text-xs text-ck-red">{error}</p> : null}
        <button
          type="submit"
          disabled={busy || auth.isLoading || !password}
          className="mt-3 w-full rounded-xl bg-ck-teal px-3 py-2 text-sm font-semibold text-on-brand disabled:opacity-50"
        >
          {busy ? "Working…" : needsSetup ? "Create owner password" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
