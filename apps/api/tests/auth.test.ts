import { describe, expect, it } from "vitest";
import request from "supertest";
import { createTestApp } from "./helpers/test-app.js";

const hasDb = Boolean(process.env.DATABASE_URL && process.env.JWT_SECRET);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe.skipIf(!hasDb)("auth flow (integration)", () => {
  const app = createTestApp();
  const email = `test-${Date.now()}@tempo.dev`;
  const password = "Password1";

  it("registers a new user", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email, password, name: "Test User" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.refreshToken).toBeTruthy();
  });

  it("rejects duplicate registration", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email, password, name: "Test User" });
    expect(res.status).toBe(409);
  });

  it("logs in, refreshes, fetches me, and logs out", async () => {
    // Wait so JWT iat differs from registration token (unique refresh_tokens constraint)
    await sleep(1100);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email, password });
    expect(login.status).toBe(200);
    expect(login.body.data.accessToken).toBeTruthy();

    let accessToken = login.body.data.accessToken as string;
    const refreshToken = login.body.data.refreshToken as string;

    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe(email);

    const refresh = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken });
    expect(refresh.status).toBe(200);
    expect(refresh.body.data.accessToken).toBeTruthy();
    accessToken = refresh.body.data.accessToken;

    const logout = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ refreshToken });
    expect(logout.status).toBe(200);
    expect(logout.body.success).toBe(true);
  });
});
