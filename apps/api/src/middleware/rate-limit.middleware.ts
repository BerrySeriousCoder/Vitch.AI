import rateLimit from "express-rate-limit";

/** Strict rate limit for auth routes (login/register) — 5 attempts per 15 min */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many attempts. Please try again in 15 minutes.",
  },
});

/** General API rate limit — 100 requests per minute */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many requests. Please slow down.",
  },
});
