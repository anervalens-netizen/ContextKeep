export type DurableReconciliationCode =
  | "idempotency_outcome_unknown"
  | "idempotency_result_expired";

export function isDurableReconciliationBarrier(
  code: unknown,
): code is DurableReconciliationCode {
  return (
    code === "idempotency_outcome_unknown" ||
    code === "idempotency_result_expired"
  );
}
