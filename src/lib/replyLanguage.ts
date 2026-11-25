interface LanguageCues {
  name: string;
  /** Common words, matched whole. A word several languages share counts for each of them. */
  words: string[];
  /** Letters or words only this language uses among the app's: they weigh more, and seen next to
   *  another language's win they make the message too mixed to call. */
  marks?: RegExp;
}

// The app's languages written in Latin letters; Japanese, Korean and Hindi go by their script.
const LATIN_LANGUAGES: LanguageCues[] = [
  {
    name: "Spanish",
    words: [
      "el", "la", "los", "las", "de", "del", "que", "por", "para", "con", "un", "una", "es", "en", "y",
      "su", "al", "no", "ya", "pero", "porque", "cuando", "esto", "este", "esta", "también", "haz",
      "hola", "ahora", "sí", "puedes", "hay", "cómo", "como", "qué", "muy", "lo", "está", "mi", "tu",
      "gracias", "dime", "cambia", "arregla", "revisa", "añade", "quita", "pon", "mira", "busca",
      "explica", "prueba", "borra", "otro", "otra", "deja", "empieza",
    ],
    // "las"/"los" are Spanish only among these languages (Portuguese says "as"/"os"), and people
    // often type without accents, so they're what tells it from Portuguese.
    marks: /[ñ¿¡]| las | los /,
  },
  {
    name: "English",
    words: [
      "the", "and", "for", "with", "what", "please", "to", "you", "your", "is", "are", "of", "on",
      "this", "it", "can", "fix", "add", "make", "why", "how", "when", "should", "does", "i", "we",
      "in", "not", "no", "now", "that", "run", "tell", "me",
    ],
  },
  {
    name: "Portuguese",
    words: [
      "o", "os", "as", "de", "do", "da", "dos", "das", "que", "por", "para", "com", "um", "uma", "é",
      "em", "e", "no", "na", "não", "mas", "porque", "quando", "isso", "este", "esta", "também", "faz",
      "olá", "agora", "sim", "pode", "você", "como", "muito", "está", "meu", "minha", "obrigado", "erro",
      "corrija", "mude", "adicione", "verifique", "faça", "explique", "remova",
    ],
    marks: /[ãõ]| você | isso | também | obrigad[oa] /,
  },
  {
    name: "French",
    words: [
      "le", "la", "les", "de", "des", "du", "que", "qui", "pour", "avec", "un", "une", "est", "et", "en",
      "pas", "ne", "je", "tu", "vous", "nous", "ce", "cette", "mais", "quand", "aussi", "merci",
      "bonjour", "peux", "fais", "maintenant", "comment", "pourquoi", "il", "sur", "dans", "au", "mon",
      "erreur", "corrige", "ajoute", "vérifie", "explique", "supprime", "lance",
    ],
    marks: /œ| vous | avec | je | c est | pourquoi | merci /,
  },
  {
    name: "Italian",
    words: [
      "il", "lo", "la", "gli", "le", "di", "del", "della", "che", "per", "con", "un", "una", "è", "e",
      "non", "sono", "questo", "questa", "anche", "quando", "perché", "ma", "nel", "nella", "puoi",
      "fai", "ciao", "ora", "adesso", "grazie", "mio", "errore", "correggi", "aggiungi", "controlla",
      "spiega", "rimuovi", "esegui",
    ],
    marks: /[ìò]| che | perché | della | nella | questo | questa | sono | gli /,
  },
  {
    name: "German",
    words: [
      "der", "die", "das", "und", "ist", "nicht", "ich", "du", "wir", "ein", "eine", "mit", "für",
      "auf", "zu", "den", "dem", "es", "bitte", "warum", "wie", "kannst", "mach", "jetzt", "auch",
      "aber", "wenn", "oder", "diese", "dieser", "datei", "fehler", "habe", "ändere", "füge", "prüfe",
      "erkläre", "lösche",
    ],
    marks: /[ßäöü]| und | nicht | ich | ist /,
  },
  {
    name: "Indonesian",
    words: [
      "yang", "dan", "di", "ini", "itu", "untuk", "dengan", "tidak", "saya", "kamu", "anda", "ada",
      "bisa", "tolong", "apa", "kenapa", "bagaimana", "sudah", "akan", "dari", "ke", "juga", "karena",
      "jika", "buat", "perbaiki", "sekarang", "terima", "kasih", "coba", "tambahkan", "ubah", "hapus",
      "jelaskan", "jalankan",
    ],
    marks: / yang | tidak | dengan | tolong /,
  },
];

// Enough to tip a close count, not to win alone: a Spanish message quoting one Portuguese word
// isn't Portuguese.
const MARK_WEIGHT = 2;

const LOCALE_NAMES: Record<string, string> = {
  de: "German",
  en: "English",
  es: "Spanish",
  fr: "French",
  hi: "Hindi",
  id: "Indonesian",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  pt: "Portuguese",
};

function proseOf(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\S*[\\/]\S*/g, " ")
    .replace(/\S+\.\w{1,5}\b/g, " ");
}

/** The language of the user's message, or null when it can't be told for sure: a wrong guess
 *  would order the model to answer in a language the user didn't write in. */
export function detectReplyLanguage(text: string): string | null {
  // A `/goal` message wraps the user's words in English instructions: only the goal is theirs.
  const goal = /<goal>([\s\S]*?)<\/goal>/.exec(text);
  const prose = proseOf(goal ? goal[1] : text);
  if (/[぀-ヿ]/.test(prose)) return "Japanese";
  if (/[가-힯]/.test(prose)) return "Korean";
  if (/[ऀ-ॿ]/.test(prose)) return "Hindi";
  const lower = prose.toLowerCase().replace(/[.,;:!?()[\]{}"'’«»-]/g, " ");
  const padded = ` ${lower.replace(/\s+/g, " ")} `;
  const scored = LATIN_LANGUAGES.map((lang) => {
    const marked = lang.marks?.test(padded) ?? false;
    const hits = lang.words.filter((w) => padded.includes(` ${w} `)).length;
    return { name: lang.name, marked, score: hits + (marked ? MARK_WEIGHT : 0) };
  }).sort((a, b) => b.score - a.score);
  const [top, second] = scored;
  if (!top.score || top.score < 2 * second.score) return null;
  if (scored.some((s) => s !== top && s.marked)) return null;
  return top.name;
}

export function languageName(locale: string): string {
  const code = locale.trim().toLowerCase().split(/[-_]/)[0];
  return LOCALE_NAMES[code] ?? locale.trim();
}

export function languageCheckNote(language: string): string {
  return `<system-reminder>Language check: the user's latest message is in ${language}. Write your ENTIRE reply — the opening message, every progress update and the final summary — in ${language}, regardless of the language of earlier messages, tool results, files, memory or these instructions. File, function and library names do NOT change this.</system-reminder>`;
}
