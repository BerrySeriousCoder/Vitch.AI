import { Router, type Request, type Response, type Router as RouterType } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { db, users, refreshTokens } from "@tempo/db";
import { loginSchema, registerSchema } from "@tempo/validators";
import { validate, authMiddleware, authLimiter, AppError } from "../middleware/index.js";
import { env } from "../config/env.js";
import type { TokenPayload } from "@tempo/types";

const router: RouterType = Router();

/** Generate JWT access token (short-lived) */
function generateAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "15m" });
}

/** Generate JWT refresh token (long-lived) */
function generateRefreshToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: "7d" });
}

// ─── Register ────────────────────────────────────────────
router.post(
  "/register",
  authLimiter,
  validate(registerSchema),
  async (req: Request, res: Response) => {
    const { email, password, name } = req.body;

    // Check if user exists
    const existing = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (existing) {
      throw new AppError(409, "Email already registered");
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const [user] = await db
      .insert(users)
      .values({ email, passwordHash, name })
      .returning({ id: users.id, email: users.email, name: users.name });

    if (!user) throw new AppError(500, "Failed to create user");

    // Generate tokens
    const tokenPayload: TokenPayload = {
      userId: user.id,
      email: user.email,
    };
    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    // Store refresh token
    await db.insert(refreshTokens).values({
      userId: user.id,
      token: refreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    res.status(201).json({
      success: true,
      data: {
        user: { id: user.id, email: user.email, name: user.name },
        accessToken,
        refreshToken,
      },
    });
  }
);

// ─── Login ───────────────────────────────────────────────
router.post(
  "/login",
  authLimiter,
  validate(loginSchema),
  async (req: Request, res: Response) => {
    const { email, password } = req.body;

    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (!user) {
      throw new AppError(401, "Invalid credentials");
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      throw new AppError(401, "Invalid credentials");
    }

    const tokenPayload: TokenPayload = {
      userId: user.id,
      email: user.email,
    };
    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    // Store refresh token
    await db.insert(refreshTokens).values({
      userId: user.id,
      token: refreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl,
        },
        accessToken,
        refreshToken,
      },
    });
  }
);

// ─── Refresh Token ───────────────────────────────────────
router.post("/refresh", async (req: Request, res: Response) => {
  const { refreshToken: token } = req.body;

  if (!token) {
    throw new AppError(400, "Refresh token required");
  }

  // Verify token
  let payload: TokenPayload;
  try {
    payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as TokenPayload;
  } catch {
    throw new AppError(401, "Invalid refresh token");
  }

  // Check if token exists in DB
  const storedToken = await db.query.refreshTokens.findFirst({
    where: eq(refreshTokens.token, token),
  });

  if (!storedToken) {
    throw new AppError(401, "Refresh token not found");
  }

  // Generate new access token
  const newAccessToken = generateAccessToken({
    userId: payload.userId,
    email: payload.email,
  });

  res.json({
    success: true,
    data: { accessToken: newAccessToken },
  });
});

// ─── Get Current User ────────────────────────────────────
router.get("/me", authMiddleware, async (req: Request, res: Response) => {
  const user = await db.query.users.findFirst({
    where: eq(users.id, req.user!.userId),
    columns: {
      id: true,
      email: true,
      name: true,
      avatarUrl: true,
      createdAt: true,
    },
  });

  if (!user) {
    throw new AppError(404, "User not found");
  }

  res.json({ success: true, data: user });
});

// ─── Logout ──────────────────────────────────────────────
router.post("/logout", authMiddleware, async (req: Request, res: Response) => {
  const { refreshToken: token } = req.body;

  if (token) {
    // Delete the specific refresh token
    await db.delete(refreshTokens).where(eq(refreshTokens.token, token));
  } else {
    // Delete all refresh tokens for this user
    await db
      .delete(refreshTokens)
      .where(eq(refreshTokens.userId, req.user!.userId));
  }

  res.json({ success: true, message: "Logged out successfully" });
});

export default router;
