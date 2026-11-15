import { useEffect, useRef, useState } from "react";

export type SubMenu = "viewport" | "cookies";

/** The browser settings menu (⋮) and its submenus, and the short notice its actions show in
 *  the address bar. */
export function useBrowserMenu() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [sub, setSub] = useState<SubMenu | null>(null);
  // Submenus open to the left unless the panel is too narrow for that.
  const [subLeft, setSubLeft] = useState(true);
  // An external site the chat asked to open that isn't on the allowed list yet.
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<number | undefined>(undefined);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const n = e.target as Node;
      if (menuRef.current?.contains(n) || menuButtonRef.current?.contains(n)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [menuOpen]);

  const toggleMenu = () => {
    setSub(null);
    setMenuOpen((o) => !o);
  };
  const openSub = (which: SubMenu) => {
    const menu = menuRef.current?.getBoundingClientRect();
    const panel = menuRef.current?.closest("aside")?.getBoundingClientRect();
    setSubLeft(!menu || !panel || menu.left - panel.left >= 232);
    setSub(which);
  };

  const notify = (msg: string) => {
    setNotice(msg);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 2500);
  };
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  return { menuOpen, setMenuOpen, menuRef, menuButtonRef, sub, setSub, subLeft, openSub, toggleMenu, notice, notify };
}
