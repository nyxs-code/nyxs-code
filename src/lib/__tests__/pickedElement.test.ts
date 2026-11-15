import { describe, it, expect } from "vitest";
import { addPickedElement, toPickedElement, type PickedElement } from "@/lib/pickedElement";

const field = (over: Partial<PickedElement> = {}): PickedElement => ({
  selector: "input.form-input",
  path: "div.modal-body > input",
  text: "",
  html: "<input class=\"form-input\">",
  ...over,
});

describe("addPickedElement", () => {
  it("keeps two elements of a dialog box that share the selector", () => {
    const list = addPickedElement(addPickedElement([], field({ uid: "n1" })), field({ uid: "n2", text: "Correo" }));
    expect(list.map((e) => e.uid)).toEqual(["n1", "n2"]);
  });

  it("refreshes an element picked twice instead of repeating it", () => {
    const list = addPickedElement(addPickedElement([], field({ uid: "n1", text: "uno" })), field({ uid: "n1", text: "dos" }));
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe("dos");
  });

  it("falls back to the selector when the page reports no node id", () => {
    const list = addPickedElement(addPickedElement([], field()), field({ text: "Otro campo igual" }));
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe("Otro campo igual");
  });
});

describe("toPickedElement", () => {
  it("keeps the node id and drops an empty one", () => {
    expect(toPickedElement({ selector: "div", uid: "n3" })?.uid).toBe("n3");
    expect(toPickedElement({ selector: "div", uid: "" })?.uid).toBeUndefined();
  });
});
