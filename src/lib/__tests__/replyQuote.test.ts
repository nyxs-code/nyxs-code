import { describe, expect, it } from "vitest";
import { quoteForReply } from "@/lib/replyQuote";

describe("quoteForReply", () => {
  it("quotes the selection and adds the reply after a blank line", () => {
    expect(quoteForReply("aunque el servidor", " test ")).toBe("> aunque el servidor\n\ntest");
  });

  it("quotes every line and keeps paragraph breaks inside the quote", () => {
    expect(quoteForReply("one\r\ntwo\n\n\n\nthree", "ok")).toBe("> one\n> two\n>\n> three\n\nok");
  });
});
