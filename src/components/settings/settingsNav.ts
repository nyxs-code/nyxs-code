import { Settings2, CircleUser, Plug, Shield, CreditCard, Gauge, Sparkles, Cable, Code2, Puzzle, Music, Info, type LucideIcon } from "lucide-react";
import { type Translations } from "@/lib/i18n";

export type SectionId =
  | "general" | "cuenta" | "providers" | "privacidad" | "facturacion" | "uso" | "capacidades"
  | "conectores" | "code"
  | "extensiones" | "musica" | "acerca";

export const NAV: { group?: string; items: { id: SectionId; label: string; badge?: string }[] }[] = [
  {
    items: [
      { id: "general", label: "General" },
      { id: "cuenta", label: "Account" },
      { id: "providers", label: "Providers" },
      { id: "privacidad", label: "Privacy" },
      { id: "code", label: "Code" },
      { id: "musica", label: "Music" },
      { id: "acerca", label: "About" },
    ],
  },
];

export const SECTION_LABEL_KEY: Record<SectionId, keyof Translations["settings"]> = {
  general: "general",
  cuenta: "account",
  providers: "providers",
  privacidad: "privacy",
  facturacion: "billing",
  uso: "usage",
  capacidades: "capabilities",
  conectores: "connectors",
  code: "code",
  extensiones: "extensions",
  musica: "music",
  acerca: "about",
};

export const NAV_ICON: Record<SectionId, LucideIcon> = {
  general: Settings2,
  cuenta: CircleUser,
  providers: Plug,
  privacidad: Shield,
  facturacion: CreditCard,
  uso: Gauge,
  capacidades: Sparkles,
  conectores: Cable,
  code: Code2,
  extensiones: Puzzle,
  musica: Music,
  acerca: Info,
};

/** Lower case without accents, so "configuracion" finds "Configuración". */
export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
