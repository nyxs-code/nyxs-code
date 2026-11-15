import { describe, expect, it } from "vitest";
import { detectReplyLanguage, languageName } from "@/lib/replyLanguage";

describe("detectReplyLanguage", () => {
  it("detects English and Spanish messages", () => {
    expect(detectReplyLanguage("Can you fix the login bug in this file?")).toBe("English");
    expect(detectReplyLanguage("arregla el error del login, por favor")).toBe("Spanish");
    expect(detectReplyLanguage("¿porque no funciona?")).toBe("Spanish");
  });

  it("ignores code, paths and names that would skew the count", () => {
    expect(detectReplyLanguage("why does src/lib/de_la_fuente.ts fail with `const el = de()`?")).toBe("English");
    expect(detectReplyLanguage("Summarize what José Fernández changed in the PR")).toBe("English");
  });

  it("returns null when there is no prose to judge", () => {
    expect(detectReplyLanguage("ok")).toBeNull();
    expect(detectReplyLanguage("src/App.tsx")).toBeNull();
    expect(detectReplyLanguage("42")).toBeNull();
  });

  it("detects languages by script", () => {
    expect(detectReplyLanguage("このバグを直して")).toBe("Japanese");
    expect(detectReplyLanguage("이 버그를 고쳐줘")).toBe("Korean");
  });

  it("detects the app's other languages instead of calling them Spanish or English", () => {
    expect(detectReplyLanguage("Você pode corrigir o erro no login? Não está funcionando.")).toBe("Portuguese");
    expect(detectReplyLanguage("Por que os testes estão falhando depois da minha mudança?")).toBe("Portuguese");
    expect(detectReplyLanguage("Peux-tu corriger le bug dans la page de connexion ? Ça ne marche pas.")).toBe("French");
    expect(detectReplyLanguage("Pourquoi les tests échouent avec cette erreur ? Je ne comprends pas.")).toBe("French");
    expect(detectReplyLanguage("Puoi correggere il bug nella pagina di login per favore? Non funziona più.")).toBe("Italian");
    expect(detectReplyLanguage("Perché il test fallisce? Sono sicuro che il codice è giusto.")).toBe("Italian");
    expect(detectReplyLanguage("Kannst du bitte den Fehler in der Login-Seite beheben? Es funktioniert nicht.")).toBe("German");
    expect(detectReplyLanguage("Warum ist der Build kaputt? Ich habe nichts geändert.")).toBe("German");
    expect(detectReplyLanguage("Tolong perbaiki bug di halaman login, tidak bisa masuk.")).toBe("Indonesian");
    expect(detectReplyLanguage("इस फ़ाइल में बग ठीक करो")).toBe("Hindi");
  });

  it("still detects ordinary Spanish and English", () => {
    expect(detectReplyLanguage("Haz que el botón de guardar use el mismo color que los demás")).toBe("Spanish");
    expect(detectReplyLanguage("Revisa los tests y dime qué falla")).toBe("Spanish");
    expect(detectReplyLanguage("hola")).toBe("Spanish");
    expect(detectReplyLanguage("cambia a por b")).toBe("Spanish");
    expect(detectReplyLanguage("Run the tests and tell me what fails")).toBe("English");
  });

  it("returns null without a clear winner or with marks of another language", () => {
    expect(detectReplyLanguage("revisa por favor, no sé por qué dice não encontrado")).toBeNull();
    expect(detectReplyLanguage("Change the button label to Größe ändern in the settings page")).toBeNull();
    expect(detectReplyLanguage("la page de login")).toBeNull();
  });
});

describe("languageName", () => {
  it("names a locale code", () => {
    expect(languageName("es-ES")).toBe("Spanish");
    expect(languageName("pt-BR")).toBe("Portuguese");
    expect(languageName("Klingon")).toBe("Klingon");
  });
});
