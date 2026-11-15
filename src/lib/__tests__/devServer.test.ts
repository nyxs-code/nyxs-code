import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
// The `beforeDevCommand` of `tauri dev` (scripts/dev-server.mjs).
import { probe } from "../../../scripts/dev-server.mjs";

const ROOT = path.resolve(__dirname, "../../..");
const icons = readFileSync(path.join(ROOT, "public", "icons.svg"));
const servers: Server[] = [];

/** A server on a free port answering /icons.svg with `status` and `body`. */
async function serve(status: number, body: Buffer | string): Promise<number> {
  const server = createServer((req, res) => {
    res.statusCode = req.url === "/icons.svg" ? status : 404;
    res.end(req.url === "/icons.svg" ? body : "");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  return (server.address() as { port: number }).port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe("dev-server probe", () => {
  it("sees a free port", async () => {
    const port = await serve(200, icons);
    servers[0].close();
    servers.length = 0;
    await new Promise((r) => setTimeout(r, 50));
    expect(await probe(port, ROOT)).toBe("free");
  });

  it("recognizes this project's Vite by a file it serves as is", async () => {
    expect(await probe(await serve(200, icons), ROOT)).toBe("ours");
  });

  it("calls anything else on the port another server", async () => {
    // Another Vite app answers unknown paths with its index.html (SPA fallback).
    expect(await probe(await serve(200, "<!doctype html><div id=root></div>"), ROOT)).toBe("other");
    expect(await probe(await serve(404, ""), ROOT)).toBe("other");
  });
});
