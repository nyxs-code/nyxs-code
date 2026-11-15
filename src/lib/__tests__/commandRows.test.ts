import { describe, it, expect } from "vitest";
import { commandRows } from "@/components/message/commandRun";

describe("commandRows", () => {
  it("splits a list of independent commands, one Run per line, comments off", () => {
    const block = "npm run tauri dev    # app de escritorio con hot reload\nnpm run dev          # solo la web en localhost:1420\nnpm test             # vitest\n";
    expect(commandRows(block).map((r) => r.command)).toEqual(["npm run tauri dev", "npm run dev", "npm test"]);
  });

  it("gives blank and comment lines no command", () => {
    expect(commandRows("# setup\nnpm i\n\nnpm test")).toEqual([
      { text: "# setup", command: null },
      { text: "npm i", command: "npm i" },
      { text: "", command: null },
      { text: "npm test", command: "npm test" },
    ]);
  });

  it("keeps a single command as one row, without prompt or trailing comment", () => {
    expect(commandRows("$ npm test  # vitest")).toEqual([{ text: "$ npm test  # vitest", command: "npm test" }]);
    expect(commandRows("# run the tests\nnpm test")).toEqual([{ text: "# run the tests\nnpm test", command: "npm test" }]);
  });

  it("keeps a # that is part of the command", () => {
    expect(commandRows("echo 'a # b'\ncurl http://x.dev/#top").map((r) => r.command)).toEqual(["echo 'a # b'", "curl http://x.dev/#top"]);
  });

  it("treats scripts as one block", () => {
    const scripts = [
      "docker run \\\n  -p 80:80 nginx",
      "Get-ChildItem `\n  -Recurse",
      "npm i &&\nnpm test",
      "if [ -f x ]; then\n  echo hi\nfi",
      "for f in *.ts\ndo echo $f\ndone",
      "cat <<EOF > a.txt\nhello\nEOF",
      "function hi {\n  echo hi\n}",
    ];
    for (const s of scripts) expect(commandRows(s)).toEqual([{ text: s, command: s }]);
  });

  it("splits one-line loops, which are complete commands", () => {
    expect(commandRows("for f in *.ts; do echo $f; done\nls").map((r) => r.command)).toEqual(["for f in *.ts; do echo $f; done", "ls"]);
  });
});
