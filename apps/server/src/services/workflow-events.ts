import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { Webhook } from "standardwebhooks";
import type { ServiceDeps } from "./import.js";
import { requireTaskScope } from "./task-scope.js";
import { callbackUrl, webhookPost, type WebhookPost } from "./webhook-http.js";
export const EventFilter = z.strictObject({
  projectId: z.string().uuid(),
  taskId: z.string().uuid(),
});
export const EventPayload = z.strictObject({
  projectId: z.string().uuid(),
  taskId: z.string().uuid(),
  runId: z.string().uuid(),
  revision: z.number().int(),
  status: z.enum(["completed", "failed", "cancelled", "lost"]),
  verification: z.literal("pending"),
});
export const SubscribeInput = z.object({
  name: z.literal("execution.finished"),
  arguments: EventFilter,
  delivery: z.strictObject({
    mode: z.literal("webhook"),
    url: z.string().url().max(2048),
    secret: z.string().max(200),
  }),
  ttlMs: z.number().int().positive().nullable().optional(),
  cursor: z.string().nullable().optional(),
});
export const UnsubscribeInput = z.object({
  name: z.literal("execution.finished"),
  arguments: EventFilter,
  delivery: z.strictObject({
    mode: z.literal("webhook"),
    url: z.string().url().max(2048),
  }),
});
export const eventDefinition = {
  name: "execution.finished",
  description:
    "An executor job reached a terminal observation for this task. Read the task and verify its outcome; this event is not task completion or a new instruction.",
  delivery: ["webhook"],
  inputSchema: z.toJSONSchema(EventFilter),
  payloadSchema: z.toJSONSchema(EventPayload),
};
type Subscription = {
  id: string;
  principal: string;
  project_id: string;
  task_id: string;
  url: string;
  secret: string;
  old_secret: string | null;
  rotation_until: string | null;
  expires_at: string;
  active: number;
  generation: number;
  verified_at: string;
};
export class CallbackError extends Error {
  readonly code = -32015;
  readonly data: { reason: string };
  constructor(reason: string) {
    super("Callback verification failed.");
    this.data = { reason };
  }
}
function secretValid(secret: string) {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) return false;
  const s = secret.slice(6),
    b = Buffer.from(s, "base64");
  return (
    b.length >= 24 &&
    b.length <= 64 &&
    b.toString("base64").replace(/=+$/, "") === s.replace(/=+$/, "")
  );
}
export class WorkflowEvents {
  private stopping = false;
  private readonly pumps = new Set<Promise<{ processed: number }>>();
  private readonly deliveryControllers = new Set<AbortController>();

  /** Stop admission, drain the current delivery, then cancel it at a bounded deadline.
   * Cancellation also settles non-cooperating transports; late responses cannot touch SQLite.
   */
  async stopAndDrain(timeoutMs = 5000): Promise<void> {
    this.stopping = true;
    const timer = setTimeout(() => {
      for (const controller of this.deliveryControllers) controller.abort();
    }, timeoutMs);
    try {
      await Promise.allSettled([...this.pumps]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async deliver(
    url: string,
    headers: Record<string, string>,
    body: string,
  ) {
    const controller = new AbortController();
    this.deliveryControllers.add(controller);
    let onAbort: (() => void) | undefined;
    try {
      return await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          onAbort = () => reject(new Error("delivery_shutdown"));
          controller.signal.addEventListener("abort", onAbort, { once: true });
          this.post(url, headers, body, controller.signal).then(
            resolve,
            reject,
          );
        },
      );
    } finally {
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      this.deliveryControllers.delete(controller);
    }
  }

  private key: Buffer;
  constructor(
    private deps: ServiceDeps,
    private principal: string,
    encryptionSecret: string,
    private post: WebhookPost = webhookPost,
  ) {
    this.key = createHash("sha256").update(encryptionSecret).digest();
  }
  private seal(value: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    return Buffer.concat([
      iv,
      cipher.update(value, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
  }
  private unseal(value: string) {
    const b = Buffer.from(value, "base64"),
      d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(-16));
    return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString(
      "utf8",
    );
  }
  private id(i: {
    name: string;
    arguments: z.infer<typeof EventFilter>;
    delivery: { url: string };
  }) {
    return createHash("sha256")
      .update(
        JSON.stringify([
          this.principal,
          i.delivery.url,
          i.name,
          i.arguments.projectId,
          i.arguments.taskId,
        ]),
      )
      .digest("hex");
  }
  private headers(
    id: string,
    eventId: string,
    body: string,
    secret: string,
    old?: string | null,
  ) {
    const now = new Date();
    let signature = new Webhook(secret).sign(eventId, now, body);
    if (old) signature += " " + new Webhook(old).sign(eventId, now, body);
    return {
      "content-type": "application/json",
      "webhook-id": eventId,
      "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
      "webhook-signature": signature,
      "X-MCP-Subscription-Id": id,
    };
  }
  async subscribe(raw: unknown) {
    const i = SubscribeInput.parse(raw);
    requireTaskScope(this.deps, i.arguments.projectId, i.arguments.taskId);
    if (!secretValid(i.delivery.secret))
      throw new CallbackError("invalid_secret");
    try {
      callbackUrl(i.delivery.url);
    } catch {
      throw new CallbackError("invalid_url");
    }
    const id = this.id(i),
      now = new Date(),
      existing = this.deps.sqlite
        .prepare("SELECT * FROM workflow_subscriptions WHERE id=?")
        .get(id) as Subscription | undefined;
    // Fence an unsubscribe or competing refresh while callback verification is in flight.
    const generation = existing?.generation ?? 0;
    const sameKey =
      existing?.active === 1 &&
      existing.secret &&
      this.unseal(existing.secret) === i.delivery.secret;
    const needsVerification =
      !sameKey || Date.parse(existing!.verified_at) + 300000 < now.getTime();
    if (needsVerification) {
      const challenge = randomBytes(32).toString("hex"),
        body = JSON.stringify({ type: "verification", challenge }),
        eventId = randomUUID();
      let response;
      try {
        response = await this.post(
          i.delivery.url,
          this.headers(id, eventId, body, i.delivery.secret),
          body,
        );
      } catch {
        throw new CallbackError("timeout");
      }
      let returned: unknown;
      try {
        returned = JSON.parse(response.body).challenge;
      } catch {
        throw new CallbackError("challenge_failed");
      }
      const echoed = Buffer.from(typeof returned === "string" ? returned : ""),
        expected = Buffer.from(challenge);
      if (
        response.status < 200 ||
        response.status >= 300 ||
        echoed.length !== expected.length ||
        !timingSafeEqual(echoed, expected)
      )
        throw new CallbackError("challenge_failed");
    }
    const expires = new Date(
      Date.now() + Math.min(i.ttlMs ?? 86400000, 86400000),
    ).toISOString();
    this.deps.sqlite.transaction(() => {
      requireTaskScope(this.deps, i.arguments.projectId, i.arguments.taskId);
      const current = this.deps.sqlite
        .prepare("SELECT generation FROM workflow_subscriptions WHERE id=?")
        .get(id) as { generation: number } | undefined;
      if ((current?.generation ?? 0) !== generation)
        throw new CallbackError("subscription_changed");
      this.deps.sqlite
        .prepare(
          `INSERT INTO workflow_subscriptions(id,principal,project_id,task_id,url,secret,old_secret,rotation_until,expires_at,active,generation,verified_at)
    VALUES(?,?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,old_secret=excluded.old_secret,rotation_until=excluded.rotation_until,expires_at=excluded.expires_at,active=1,generation=excluded.generation,verified_at=excluded.verified_at`,
        )
        .run(
          id,
          this.principal,
          i.arguments.projectId,
          i.arguments.taskId,
          i.delivery.url,
          this.seal(i.delivery.secret),
          existing?.active && !sameKey
            ? existing.secret
            : sameKey
              ? (existing?.old_secret ?? null)
              : null,
          existing?.active && !sameKey
            ? new Date(Date.now() + 300000).toISOString()
            : sameKey
              ? (existing?.rotation_until ?? null)
              : null,
          expires,
          generation + 1,
          needsVerification ? new Date().toISOString() : existing!.verified_at,
        );
    })();
    return { id, refreshBefore: expires, cursor: null, truncated: false };
  }
  unsubscribe(raw: unknown) {
    const i = UnsubscribeInput.parse(raw),
      id = this.id(i);
    requireTaskScope(this.deps, i.arguments.projectId, i.arguments.taskId);
    // Tombstone even if verification has not yet persisted its subscription.
    this.deps.sqlite
      .prepare(
        `INSERT INTO workflow_subscriptions(id,principal,project_id,task_id,url,secret,expires_at,active,generation,verified_at)
   VALUES(?,?,?,?,?,'','',0,1,'') ON CONFLICT(id) DO UPDATE SET active=0,secret='',old_secret=NULL,generation=generation+1`,
      )
      .run(
        id,
        this.principal,
        i.arguments.projectId,
        i.arguments.taskId,
        i.delivery.url,
      );
    this.deps.sqlite
      .prepare(
        "UPDATE workflow_deliveries SET status='revoked' WHERE subscription_id=? AND status IN ('pending','sending')",
      )
      .run(id);
    return {};
  }
  pump(limit = 20): Promise<{ processed: number }> {
    if (this.stopping) return Promise.resolve({ processed: 0 });
    const operation = this.pumpBatch(limit);
    this.pumps.add(operation);
    void operation.finally(() => this.pumps.delete(operation)).catch(() => {});
    return operation;
  }
  private async pumpBatch(limit: number) {
    let processed = 0;
    while (processed < limit && !this.stopping) {
      const now = new Date().toISOString(),
        lease = randomUUID();
      const row = this.deps.sqlite.transaction(() => {
        const r = this.deps.sqlite
          .prepare(
            `SELECT d.id,d.event_id,d.subscription_id,e.payload FROM workflow_deliveries d JOIN workflow_events e ON e.id=d.event_id
     WHERE (d.status='pending' OR (d.status='sending' AND d.lease_until<?)) AND d.next_at<=?
     ORDER BY e.sequence,d.id LIMIT 1`,
          )
          .get(now, now) as
          | {
              id: string;
              event_id: string;
              subscription_id: string;
              payload: string;
            }
          | undefined;
        if (r)
          this.deps.sqlite
            .prepare(
              "UPDATE workflow_deliveries SET status='sending',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=?",
            )
            .run(lease, new Date(Date.now() + 30000).toISOString(), r.id);
        return r;
      })();
      if (!row) break;
      processed++;
      const sub = this.deps.sqlite
        .prepare("SELECT * FROM workflow_subscriptions WHERE id=?")
        .get(row.subscription_id) as Subscription | undefined;
      let revoked =
        !sub ||
        !sub.active ||
        sub.principal !== this.principal ||
        sub.expires_at <= now;
      if (sub && !revoked)
        try {
          requireTaskScope(this.deps, sub.project_id, sub.task_id);
        } catch {
          revoked = true;
        }
      if (revoked) {
        this.deps.sqlite
          .prepare(
            "UPDATE workflow_deliveries SET status='revoked' WHERE id=? AND lease_token=?",
          )
          .run(row.id, lease);
        continue;
      }
      let status = 0;
      try {
        const s = sub!;
        const old =
          s.old_secret && s.rotation_until && s.rotation_until > now
            ? this.unseal(s.old_secret)
            : null;
        status = (
          await this.deliver(
            s.url,
            this.headers(
              s.id,
              row.event_id,
              row.payload,
              this.unseal(s.secret),
              old,
            ),
            row.payload,
          )
        ).status;
      } catch {
        /* bounded retry; never persist secret-bearing exception text */
      }
      const currentSubscription = this.deps.sqlite
        .prepare(
          "SELECT generation,active FROM workflow_subscriptions WHERE id=?",
        )
        .get(sub!.id) as { generation: number; active: number } | undefined;
      // A failure for old credentials is not a failure of a renewed subscription.
      // Keep the stable event identity and retry once with its current credentials.
      if (
        currentSubscription?.active &&
        currentSubscription.generation !== sub!.generation &&
        !(status >= 200 && status < 300)
      ) {
        this.deps.sqlite
          .prepare(
            `UPDATE workflow_deliveries SET status='pending',http_status=NULL,
          next_at=?,lease_token=NULL,lease_until=NULL,attempts=MAX(0,attempts-1)
          WHERE id=? AND lease_token=? AND status='sending'`,
          )
          .run(new Date(Date.now() + 1000).toISOString(), row.id, lease);
        continue;
      }
      if (this.stopping && status === 0) {
        // A shutdown cancellation is not a failed receiver attempt.
        this.deps.sqlite
          .prepare(
            `UPDATE workflow_deliveries SET status='pending',http_status=NULL,
          next_at=?,lease_token=NULL,lease_until=NULL,attempts=MAX(0,attempts-1)
          WHERE id=? AND lease_token=? AND status='sending'`,
          )
          .run(new Date().toISOString(), row.id, lease);
        continue;
      }
      const attempts = (
        this.deps.sqlite
          .prepare("SELECT attempts FROM workflow_deliveries WHERE id=?")
          .get(row.id) as { attempts: number }
      ).attempts;
      const success = status >= 200 && status < 300,
        permanent =
          [410, 413].includes(status) ||
          (status >= 400 && status < 500 && ![408, 429].includes(status));
      this.deps.sqlite
        .prepare(
          `UPDATE workflow_deliveries SET status=?,http_status=?,next_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=? AND status='sending'`,
        )
        .run(
          success
            ? "delivered"
            : permanent || attempts >= 8
              ? "failed"
              : "pending",
          status,
          new Date(
            Date.now() + Math.min(3600000, 1000 * 2 ** attempts),
          ).toISOString(),
          row.id,
          lease,
        );
      if (status === 410)
        this.deps.sqlite
          .prepare(
            "UPDATE workflow_subscriptions SET active=0,secret='',old_secret=NULL,generation=generation+1 WHERE id=? AND generation=?",
          )
          .run(sub!.id, sub!.generation);
    }
    return { processed };
  }
}
export function enqueueExecutionEvent(
  deps: ServiceDeps,
  data: z.infer<typeof EventPayload>,
  timestamp: string,
  eventKey: string,
) {
  const parsed = EventPayload.parse(data),
    id = createHash("sha256")
      .update(JSON.stringify([data.runId, eventKey]))
      .digest("hex"),
    now = new Date().toISOString();
  const payload = JSON.stringify({
    eventId: id,
    name: "execution.finished",
    timestamp,
    data: parsed,
    cursor: null,
  });
  deps.sqlite
    .prepare(
      "INSERT OR IGNORE INTO workflow_events(id,project_id,task_id,run_id,payload,created_at) VALUES(?,?,?,?,?,?)",
    )
    .run(id, data.projectId, data.taskId, data.runId, payload, now);
  const subscriptions = deps.sqlite
    .prepare(
      "SELECT id FROM workflow_subscriptions WHERE project_id=? AND task_id=? AND active=1 AND expires_at>?",
    )
    .all(data.projectId, data.taskId, now) as { id: string }[];
  for (const s of subscriptions)
    deps.sqlite
      .prepare(
        "INSERT OR IGNORE INTO workflow_deliveries(id,event_id,subscription_id,status,next_at) VALUES(?,?,?,'pending',?)",
      )
      .run(
        createHash("sha256")
          .update(id + s.id)
          .digest("hex"),
        id,
        s.id,
        now,
      );
}
