import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "test-secret",
    JWT_REFRESH_SECRET: "test-refresh",
    DATABASE_URL: "postgresql://test",
    API_PORT: 3001,
    NODE_ENV: "test",
  },
}));

vi.mock("jsonwebtoken", () => ({
  default: {
    verify: vi.fn(),
  },
}));

import jwt from "jsonwebtoken";
import { authMiddleware } from "./auth.middleware.js";
import { AppError } from "./error.middleware.js";

const mockedVerify = vi.mocked(jwt.verify);

function mockReq(authHeader?: string): Request {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
  } as Request;
}

describe("authMiddleware", () => {
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    next = vi.fn();
  });

  it("rejects missing bearer token", () => {
    expect(() => authMiddleware(mockReq(), {} as Response, next)).toThrow(AppError);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects invalid token", () => {
    mockedVerify.mockImplementation(() => {
      throw new Error("bad token");
    });
    expect(() =>
      authMiddleware(mockReq("Bearer bad"), {} as Response, next)
    ).toThrow(AppError);
  });

  it("attaches user and calls next for valid token", () => {
    mockedVerify.mockReturnValue({
      userId: "u1",
      email: "a@b.com",
    } as any);

    const req = mockReq("Bearer good-token");
    authMiddleware(req, {} as Response, next);

    expect(req.user).toEqual({ userId: "u1", email: "a@b.com" });
    expect(next).toHaveBeenCalledOnce();
  });
});
