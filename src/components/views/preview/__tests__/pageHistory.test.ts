import { describe, expect, it } from "vitest";
import { applyNavReport, pushAddress, type NavContext, type PageHistory } from "../pageHistory";

const A = "https://a.com/";
const B = "https://a.com/b";
const C = "https://a.com/c";
const h = (list: string[], i = list.length - 1): PageHistory => ({ list, i });
const ctx = (last: NavContext["last"] = null, replaceNext = false): NavContext => ({ last, replaceNext });
const report = (url: string, length: number, canForward: boolean | null = false) => ({ url, length, canForward });

describe("pushAddress", () => {
  it("drops what was ahead and doesn't repeat the current address", () => {
    expect(pushAddress(h([A, B, C], 0), C)).toEqual(h([A, C]));
    const same = h([A, B]);
    expect(pushAddress(same, B)).toBe(same);
    expect(pushAddress(h([], -1), A)).toEqual(h([A]));
  });
});

describe("applyNavReport", () => {
  it("adds a page the site went to on its own", () => {
    expect(applyNavReport(h([A]), report(B, 2), ctx({ length: 1, canForward: false }))).toEqual(h([A, B]));
  });

  it("changes nothing when the page is where the tab already is", () => {
    const at = h([A, B]);
    expect(applyNavReport(at, report(B, 2), ctx())).toBe(at);
  });

  it("follows a step back or forward in the page's own history", () => {
    expect(applyNavReport(h([A, B, C]), report(B, 3, true), ctx({ length: 3, canForward: false }))).toEqual(h([A, B, C], 1));
    expect(applyNavReport(h([A, B, C], 1), report(C, 3, false), ctx({ length: 3, canForward: true }))).toEqual(h([A, B, C], 2));
  });

  it("puts a redirect after the tab's own navigation in that entry, so Back doesn't redirect again", () => {
    expect(applyNavReport(h([A, "http://x.com/"]), report("https://www.x.com/", 2), ctx(null, true))).toEqual(h([A, "https://www.x.com/"]));
  });

  it("takes replaceState for what it is: the same history, another address", () => {
    expect(applyNavReport(h([A, B]), report(`${B}?q=1`, 2), ctx({ length: 2, canForward: false }))).toEqual(h([A, `${B}?q=1`]));
  });

  it("adds a page reached after going back, dropping what was ahead", () => {
    // Back from C to B, then a link: the page's history is as long as before, but it can no
    // longer go forward.
    expect(applyNavReport(h([A, B, C], 1), report("https://a.com/d", 3, false), ctx({ length: 3, canForward: true }))).toEqual(h([A, B, "https://a.com/d"]));
  });

  it("starts the history from a report when it had none", () => {
    expect(applyNavReport(h([], -1), report(A, 1), ctx(null, true))).toEqual(h([A]));
  });
});
