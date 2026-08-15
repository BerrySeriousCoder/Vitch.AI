import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createTestApp } from "./helpers/test-app.js";

const hasDb = Boolean(process.env.DATABASE_URL && process.env.JWT_SECRET);

describe.skipIf(!hasDb)("font upload (integration)", () => {
  const app = createTestApp();
  const email = `fonts-${Date.now()}@tempo.dev`;
  let accessToken = "";
  let projectId = "";
  let fontId = "";

  beforeAll(async () => {
    const reg = await request(app)
      .post("/api/auth/register")
      .send({ email, password: "Password1", name: "Font Tester" });
    accessToken = reg.body.data.accessToken;

    const proj = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ name: "Font Project" });
    projectId = proj.body.data.id;
  });

  it("rejects non-font uploads", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );

    const res = await request(app)
      .post(`/api/projects/${projectId}/fonts`)
      .set("Authorization", `Bearer ${accessToken}`)
      .attach("file", png, { filename: "pixel.png", contentType: "image/png" });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("uploads a font file", async () => {
    // Opaque buffer is enough for storage + DB; client FontFace not exercised here
    const ttf = Buffer.from("tempo-fake-font-bytes");

    const res = await request(app)
      .post(`/api/projects/${projectId}/fonts`)
      .set("Authorization", `Bearer ${accessToken}`)
      .field("familyName", "Tempo Test")
      .attach("file", ttf, {
        filename: "TempoTest.ttf",
        contentType: "font/ttf",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeTruthy();
    expect(res.body.data.familyName).toBe("Tempo Test");
    expect(res.body.data.format).toBe("truetype");
    expect(res.body.data.url).toMatch(/^\/uploads\//);
    fontId = res.body.data.id;
  });

  it("lists project fonts", async () => {
    const res = await request(app)
      .get(`/api/projects/${projectId}/fonts`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some((a: { id: string }) => a.id === fontId)).toBe(
      true
    );
  });

  it("deletes a font", async () => {
    const res = await request(app)
      .delete(`/api/projects/${projectId}/fonts/${fontId}`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);

    const list = await request(app)
      .get(`/api/projects/${projectId}/fonts`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(list.body.data.some((a: { id: string }) => a.id === fontId)).toBe(
      false
    );
  });
});
