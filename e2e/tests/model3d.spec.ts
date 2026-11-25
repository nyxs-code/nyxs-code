import { test, expect } from "../fixtures";

// A cube as an ASCII STL: 12 triangles, 2 units a side.
const CUBE = (() => {
  const v = [-1, 1];
  const faces: number[][][] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => faces.push([a, b, c], [a, c, d]);
  for (const s of v) {
    quad([s, -1, -1], [s, 1, -1], [s, 1, 1], [s, -1, 1]);
    quad([-1, s, -1], [1, s, -1], [1, s, 1], [-1, s, 1]);
    quad([-1, -1, s], [1, -1, s], [1, 1, s], [-1, 1, s]);
  }
  const facet = (f: number[][]) => `facet normal 0 0 0\n outer loop\n${f.map((p) => `  vertex ${p.join(" ")}`).join("\n")}\n endloop\nendfacet`;
  return `solid cube\n${faces.map(facet).join("\n")}\nendsolid cube\n`;
})();

test("a 3D model opens in the Files panel's 3D view", async ({ page, app }) => {
  await app({ files: { "cube.stl": CUBE } });
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByText("cube.stl", { exact: true }).first().click();
  const view = page.getByRole("img", { name: "3D view of cube.stl" });
  await expect(view).toBeVisible();
  await expect(page.getByText(/^12 triangles · 2 × 2 × 2/)).toBeVisible();
  await expect(view.locator("canvas")).toHaveCount(1);
  if (process.env.MODEL_SHOTS) await view.screenshot({ path: `${process.env.MODEL_SHOTS}/model.png` });
});
