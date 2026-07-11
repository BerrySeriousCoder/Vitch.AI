import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

/** Custom application error */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public isOperational = true
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** 404 handler */
export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    success: false,
    error: `Route ${req.method} ${req.path} not found`,
  });
}

/** Global error handler */
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  // Zod validation error
  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: "Validation failed",
      details: err.errors,
    });
    return;
  }

  // Custom app error
  if (err instanceof AppError) {
    // Expected 4xx control flow (including access-token refresh) should not be
    // printed as an application crash with a full stack trace.
    if (!err.isOperational || err.statusCode >= 500) console.error("Error:", err);
    res.status(err.statusCode).json({
      success: false,
      error: err.message,
    });
    return;
  }

  // Unknown error
  console.error("Error:", err);
  res.status(500).json({
    success: false,
    error:
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message,
  });
}
