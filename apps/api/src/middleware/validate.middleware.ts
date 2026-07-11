import type { Request, Response, NextFunction } from "express";
import { type ZodSchema } from "zod";
import { AppError } from "./error.middleware.js";

/** Middleware factory to validate request body against a Zod schema */
export function validate(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      throw new AppError(400, result.error.errors[0]?.message ?? "Validation failed");
    }
    req.body = result.data;
    next();
  };
}
