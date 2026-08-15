import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createTestApp } from "./helpers/test-app.js";

const hasDb = Boolean(process.env.DATABASE_URL && process.env.JWT_SECRET);

describe.skipIf(!hasDb)("media upload (integration)", () => {
  const app = createTestApp();
  const email = `media-${Date.now()}@tempo.dev`;
  let accessToken = "";
  let projectId = "";
  let mediaId = "";

  beforeAll(async () => {
    const reg = await request(app)
      .post("/api/auth/register")
      .send({ email, password: "Password1", name: "Media Tester" });
    accessToken = reg.body.data.accessToken;

    const proj = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ name: "Media Project" });
    projectId = proj.body.data.id;
  });

  it("uploads an image file", async () => {
    // Minimal 1x1 PNG
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );

    const res = await request(app)
      .post(`/api/projects/${projectId}/media`)
      .set("Authorization", `Bearer ${accessToken}`)
      .attach("file", png, { filename: "pixel.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeTruthy();
    expect(res.body.data.type).toBe("image");
    mediaId = res.body.data.id;
  });

  it("lists media assets", async () => {
    const res = await request(app)
      .get(`/api/projects/${projectId}/media`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some((a: any) => a.id === mediaId)).toBe(true);
  });

  it("deletes a media asset", async () => {
    const res = await request(app)
      .delete(`/api/projects/${projectId}/media/${mediaId}`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
  });
});
