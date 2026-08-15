import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createTestApp } from "./helpers/test-app.js";

const hasDb = Boolean(process.env.DATABASE_URL && process.env.JWT_SECRET);

describe.skipIf(!hasDb)("projects CRUD (integration)", () => {
  const app = createTestApp();
  const email = `proj-${Date.now()}@tempo.dev`;
  let accessToken = "";
  let projectId = "";

  beforeAll(async () => {
    const reg = await request(app)
      .post("/api/auth/register")
      .send({ email, password: "Password1", name: "Project Tester" });
    accessToken = reg.body.data.accessToken;
  });

  it("creates a project", async () => {
    const res = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ name: "Integration Project" });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeTruthy();
    projectId = res.body.data.id;
  });

  it("lists projects", async () => {
    const res = await request(app)
      .get("/api/projects")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((p: any) => p.id === projectId)).toBe(true);
  });

  it("gets a single project", async () => {
    const res = await request(app)
      .get(`/api/projects/${projectId}`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Integration Project");
  });

  it("updates a project", async () => {
    const res = await request(app)
      .patch(`/api/projects/${projectId}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ name: "Renamed Project", data: { tracks: [] } });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Renamed Project");
  });

  it("deletes a project", async () => {
    const res = await request(app)
      .delete(`/api/projects/${projectId}`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect([200, 204]).toContain(res.status);
  });
});
