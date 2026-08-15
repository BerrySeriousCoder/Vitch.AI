import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createTestApp } from "./helpers/test-app.js";

const hasDb = Boolean(process.env.DATABASE_URL && process.env.JWT_SECRET);

const MINI_CUBE = `TITLE "Test"
LUT_3D_SIZE 2
0.0 0.0 0.0
1.0 0.0 0.0
0.0 1.0 0.0
1.0 1.0 0.0
0.0 0.0 1.0
1.0 0.0 1.0
0.0 1.0 1.0
1.0 1.0 1.0
`;

describe.skipIf(!hasDb)("lut upload (integration)", () => {
  const app = createTestApp();
  const email = `luts-${Date.now()}@tempo.dev`;
  let accessToken = "";
  let projectId = "";
  let lutId = "";

  beforeAll(async () => {
    const reg = await request(app)
      .post("/api/auth/register")
      .send({ email, password: "Password1", name: "LUT Tester" });
    accessToken = reg.body.data.accessToken;

    const proj = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ name: "LUT Project" });
    projectId = proj.body.data.id;
  });

  it("rejects non-cube uploads", async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/luts`)
      .set("Authorization", `Bearer ${accessToken}`)
      .attach("file", Buffer.from("not a lut"), {
        filename: "x.png",
        contentType: "image/png",
      });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("uploads a .cube file", async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/luts`)
      .set("Authorization", `Bearer ${accessToken}`)
      .field("name", "Test LUT")
      .attach("file", Buffer.from(MINI_CUBE), {
        filename: "test.cube",
        contentType: "application/octet-stream",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeTruthy();
    expect(res.body.data.name).toBe("Test LUT");
    expect(res.body.data.format).toBe("cube");
    expect(res.body.data.size).toBe(2);
    lutId = res.body.data.id;
  });

  it("lists and deletes", async () => {
    const list = await request(app)
      .get(`/api/projects/${projectId}/luts`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.some((a: { id: string }) => a.id === lutId)).toBe(true);

    const del = await request(app)
      .delete(`/api/projects/${projectId}/luts/${lutId}`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(del.status).toBe(200);
  });
});
