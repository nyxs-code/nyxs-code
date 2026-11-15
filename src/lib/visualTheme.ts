import interUrl from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";

/** The app's look for the agent's visuals (```preview blocks). The names follow the design-token
 *  vocabulary models already know from Claude's visuals (--surface-1, --text-secondary,
 *  --border, --bg-success…), filled with Nyxs' current theme, so a visual drops into the chat
 *  without looking embedded. The visual lives on another origin, so the font travels inside as a
 *  data URL; the Tabler icon font comes from its CDN. */

let fontData: Promise<string> | null = null;

function interDataUrl(): Promise<string> {
  fontData ??= fetch(interUrl)
    .then((r) => r.blob())
    .then(
      (blob) =>
        new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]*;/, "data:font/woff2;"));
          reader.onerror = () => resolve("");
          reader.readAsDataURL(blob);
        }),
    )
    .catch(() => "");
  return fontData;
}

const TABLER_CSS = "https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3/dist/tabler-icons.min.css";

/** Categorical color ramps for SVG nodes and tags: 50, 100, 200, 400, 600, 800, 900. */
const RAMPS: Record<string, string[]> = {
  gray: ["#F1EFE8", "#D3D1C7", "#B4B2A9", "#888780", "#5F5E5A", "#444441", "#2C2C2A"],
  blue: ["#E6F1FB", "#B5D4F4", "#85B7EB", "#378ADD", "#185FA5", "#0C447C", "#042C53"],
  teal: ["#E1F5EE", "#9FE1CB", "#5DCAA5", "#1D9E75", "#0F6E56", "#085041", "#04342C"],
  green: ["#EAF3DE", "#C0DD97", "#97C459", "#639922", "#3B6D11", "#27500A", "#173404"],
  amber: ["#FAEEDA", "#FAC775", "#EF9F27", "#BA7517", "#854F0B", "#633806", "#412402"],
  coral: ["#FAECE7", "#F5C4B3", "#F0997B", "#D85A30", "#993C1D", "#712B13", "#4A1B0C"],
  red: ["#FCEBEB", "#F7C1C1", "#F09595", "#E24B4A", "#A32D2D", "#791F1F", "#501313"],
  pink: ["#FBEAF0", "#F4C0D1", "#ED93B1", "#D4537E", "#993556", "#72243E", "#4B1528"],
  purple: ["#EEEDFE", "#CECBF6", "#AFA9EC", "#7F77DD", "#534AB7", "#3C3489", "#26215C"],
};

function rampCss(dark: boolean): string {
  return Object.entries(RAMPS)
    .map(([name, [s50, , s200, s400, s600, s800, s900]]) => {
      const fill = dark ? s800 : s50;
      const stroke = dark ? s200 : s600;
      const title = dark ? s50 : s800;
      const sub = dark ? s200 : s600;
      const shapes = `.c-${name}:is(rect,circle,ellipse,polygon),.c-${name}>:is(rect,circle,ellipse,polygon)`;
      return `${shapes}{fill:${fill};stroke:${stroke};}.c-${name} :is(.t,.th){fill:${title};}.c-${name} .ts{fill:${sub};}.tag-${name}{background:${fill};color:${dark ? s50 : s900};}.dot-${name}{color:${s400};}`;
    })
    .join("");
}

export async function visualThemeCss(): Promise<string> {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  const dark = root.classList.contains("dark");
  const font = await interDataUrl();
  const face = font ? `@font-face{font-family:"Inter Variable";font-style:normal;font-weight:100 900;font-display:block;src:url(${font}) format("woff2");}` : "";
  const role = (name: string, color: string) =>
    `--fill-${name}:${color};--text-${name}:${color};--bg-${name}:color-mix(in srgb,${color} ${dark ? 22 : 13}%,transparent);--border-${name}:color-mix(in srgb,${color} 45%,transparent);`;
  return `@import url("${TABLER_CSS}");
${face}
:root{color-scheme:${dark ? "dark" : "light"};
--surface-0:${v("--bg-0")};--surface-1:${v("--bg-200")};--surface-2:${v("--bg-100")};--surface-3:${v("--bg-100")};
--text-primary:${v("--text-100")};--text-secondary:${v("--text-300")};--text-muted:${v("--text-400")};--text-disabled:${v("--text-500")};
--border:color-mix(in srgb,var(--text-primary) 14%,transparent);--border-strong:color-mix(in srgb,var(--text-primary) 24%,transparent);--border-stronger:color-mix(in srgb,var(--text-primary) 40%,transparent);
${role("accent", v("--accent"))}${role("success", v("--success"))}${role("warning", v("--warning"))}${role("danger", v("--danger"))}
--text-link:${v("--link")};--fill-hover:color-mix(in srgb,var(--text-primary) ${dark ? 8 : 5}%,transparent);
--radius:6px;--pad-sm:6px;--pad-md:10px;--pad-lg:14px;--pad-xl:20px;--gap-xs:4px;--gap-sm:8px;--gap-md:12px;--gap-lg:16px;--gap-xl:24px;
--font-sans:"Inter Variable",Inter,system-ui,-apple-system,"Segoe UI",sans-serif;--font-mono:ui-monospace,"Cascadia Code",Consolas,monospace;--font-voice:Georgia,"Times New Roman",serif;}
*,*::before,*::after{box-sizing:border-box;}
html,body{margin:0;background:transparent;}
body{color:var(--text-primary);font:14px/1.6 var(--font-sans);-webkit-font-smoothing:antialiased;}
h1,h2,h3,h4{color:var(--text-primary);font-weight:500;margin:0 0 .5em;line-height:1.3;}h1{font-size:22px;}h2{font-size:18px;}h3{font-size:16px;}h4{font-size:14px;}
p{margin:0 0 .75em;}small{font-size:12px;}
a{color:var(--text-link);text-decoration:none;}a:hover{text-decoration:underline;}
code,pre,kbd{font-family:var(--font-mono);font-size:12.5px;}
button{font:inherit;font-size:13px;color:var(--text-primary);background:transparent;border:0.5px solid var(--border-strong);border-radius:var(--radius);padding:5px 12px;cursor:pointer;transition:background .12s,transform .06s;}
button:hover{background:var(--fill-hover);}button:active{transform:scale(.98);}
input:not([type=range]):not([type=checkbox]):not([type=radio]),select,textarea{font:inherit;font-size:13px;color:var(--text-primary);background:var(--surface-2);border:0.5px solid var(--border-strong);border-radius:var(--radius);padding:0 10px;height:34px;outline:none;}
textarea{height:auto;padding:8px 10px;}
input:focus,select:focus,textarea:focus{border-color:var(--fill-accent);box-shadow:0 0 0 2px var(--bg-accent);}
input[type=range],input[type=checkbox],input[type=radio]{accent-color:var(--fill-accent);}
hr{border:0;border-top:0.5px solid var(--border);margin:1rem 0;}
.ti{font-size:16px;line-height:1;vertical-align:-2px;}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0;}
svg text{font-family:var(--font-sans);}.t{fill:var(--text-primary);font-size:14px;}.th{fill:var(--text-primary);font-size:14px;font-weight:500;}.ts{fill:var(--text-secondary);font-size:12px;}
${rampCss(dark)}`;
}
