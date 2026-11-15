// Draws the shadows of the app's panels (a dialog, a menu) that the page has a hole cut for. The
// panel shows through the hole, but its shadow falls on the page, which covers the app there: the
// page draws it instead, above its dim layer, or the panel looks pasted onto the site. `a.w` is the
// page's width in the app's pixels, to follow a page the user zoomed; no boxes takes them away.
(function (a) {
  var old = document.getElementById("__nyxs-shadows");
  if (old) old.remove();
  if (!a || !a.boxes || !a.boxes.length) return;
  var k = a.w > 0 ? window.innerWidth / a.w : 1;
  var c = document.createElement("div");
  c.id = "__nyxs-shadows";
  c.setAttribute("aria-hidden", "true");
  c.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden";
  a.boxes.forEach(function (b) {
    var d = document.createElement("div");
    d.style.cssText = "position:absolute;pointer-events:none";
    d.style.left = b.x * k + "px";
    d.style.top = b.y * k + "px";
    d.style.width = b.width * k + "px";
    d.style.height = b.height * k + "px";
    d.style.borderRadius = b.radius * k + "px";
    d.style.boxShadow = b.shadow;
    c.appendChild(d);
  });
  document.documentElement.appendChild(c);
})
