import type { z } from "zod";
import { ApiError } from "./errors.js";

export function parseWith<T extends z.ZodType>(schema: T, data: unknown, what = "payload"): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ApiError(400, "validation_error", `Invalid ${what}.`, result.error.issues);
  }
  return result.data;
}
