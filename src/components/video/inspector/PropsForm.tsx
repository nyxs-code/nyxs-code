import { useState } from "react";
import { Braces, ListTree } from "lucide-react";
import type { Translations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ColorInput, INPUT, NumberInput, Row, TextInput, Toggle } from "./fields";

type T = Translations["videoPanel"];

const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(.+\)|hsla?\(.+\))$/i;

/** A scene clip's props: a form built from the JSON values (text, number, color, switch), with
 *  objects and arrays as small JSON fields, or the whole thing as JSON. */
export function PropsForm({ props, onChange, t }: { props: Record<string, unknown>; onChange: (p: Record<string, unknown> | undefined) => void; t: T }) {
  const [asJson, setAsJson] = useState(false);
  const entries = Object.entries(props);
  const set = (key: string, value: unknown) => onChange({ ...props, [key]: value });

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-text-300">{t.sceneProps}</span>
        <button
          type="button"
          onClick={() => setAsJson(!asJson)}
          className="flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[11.5px] text-text-300 hover:bg-bg-200 hover:text-text-100"
        >
          {asJson ? <ListTree className="h-3.5 w-3.5" /> : <Braces className="h-3.5 w-3.5" />}
          {asJson ? t.editForm : t.editJson}
        </button>
      </div>
      {asJson ? (
        <JsonField value={props} onCommit={(v) => onChange(v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length ? (v as Record<string, unknown>) : undefined)} t={t} rows={8} />
      ) : entries.length === 0 ? (
        <p className="text-[12px] text-text-400">{t.noProps}</p>
      ) : (
        entries.map(([key, value]) => (
          <Row key={key} label={<span className="font-mono text-[11.5px]">{key}</span>}>
            {typeof value === "boolean" ? (
              <Toggle on={value} label={key} onChange={(v) => set(key, v)} />
            ) : typeof value === "number" ? (
              <NumberInput aria-label={key} value={value} precision={Number.isInteger(value) ? 0 : 2} step={Number.isInteger(value) ? 1 : 0.1} onChange={(v) => set(key, v)} />
            ) : typeof value === "string" && COLOR_RE.test(value) ? (
              <ColorInput aria-label={key} value={value} onChange={(v) => set(key, v ?? "")} />
            ) : typeof value === "string" ? (
              <TextInput aria-label={key} value={value} multiline={value.length > 40} onCommit={(v) => set(key, v)} />
            ) : (
              <JsonField value={value} onCommit={(v) => set(key, v)} t={t} rows={3} />
            )}
          </Row>
        ))
      )}
    </div>
  );
}

function JsonField({ value, onCommit, t, rows }: { value: unknown; onCommit: (v: unknown) => void; t: T; rows: number }) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? JSON.stringify(value, null, 2);
  let invalid = false;
  if (text !== null) {
    try {
      JSON.parse(text);
    } catch {
      invalid = true;
    }
  }
  return (
    <div className="min-w-0 flex-1">
      <textarea
        value={shown}
        rows={rows}
        spellCheck={false}
        aria-invalid={invalid}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        onBlur={() => {
          if (text === null || invalid) return;
          onCommit(JSON.parse(text));
          setText(null);
        }}
        className={cn(INPUT, "h-auto resize-y py-1 font-mono text-[11.5px] leading-snug custom-scrollbar", invalid && "border-red-500/70 focus:border-red-500")}
      />
      {invalid && <p className="mt-0.5 text-[11px] text-red-500">{t.invalidJson}</p>}
    </div>
  );
}
