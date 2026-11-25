import { describe, expect, it } from "vitest";
import { base64ToBytes, gltfNeedsOtherFiles, modelFormat, modelInfo } from "@/lib/model3d";

describe("3D models", () => {
  it("are told by their extension", () => {
    expect(modelFormat("D:/p/assets/Robot.GLB")).toBe("glb");
    expect(modelFormat("part.stl")).toBe("stl");
    expect(modelFormat("scene.gltf")).toBe("gltf");
    expect(modelFormat("mesh.obj")).toBe("obj");
    expect(modelFormat("photo.png")).toBeNull();
  });

  it("know when a .gltf keeps its shape in other files", () => {
    expect(gltfNeedsOtherFiles(JSON.stringify({ buffers: [{ uri: "scene.bin" }] }))).toBe(true);
    expect(gltfNeedsOtherFiles(JSON.stringify({ buffers: [{ uri: "data:application/octet-stream;base64,AAAA" }], images: [{ uri: "tex.png" }] }))).toBe(true);
    expect(gltfNeedsOtherFiles(JSON.stringify({ buffers: [{ uri: "data:application/octet-stream;base64,AAAA" }] }))).toBe(false);
    expect(gltfNeedsOtherFiles("not json")).toBe(false);
  });

  it("describe their triangles and size in the user's language", () => {
    const template = "{triangles} triangles · {width} × {height} × {depth}";
    expect(modelInfo(12480, { x: 2.4, y: 1.1, z: 0.84321 }, "en-US", template)).toBe("12,480 triangles · 2.4 × 1.1 × 0.843");
    expect(modelInfo(12480, { x: 2.4, y: 1, z: 0.5 }, "es-ES", template)).toBe("12.480 triangles · 2,4 × 1 × 0,5");
  });

  it("decode base64 to bytes", () => {
    expect([...base64ToBytes("AAEC/w==")]).toEqual([0, 1, 2, 255]);
  });
});
