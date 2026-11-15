import type { UpdateCardSpec } from "@/lib/updateCard";

/**
 * The 0.8.53 card, as a reference: the dev preview of the update alert, the card harness
 * (`dev/update-card.html`) and the tests use it, and the skill points at it as an example of
 * every common scene.
 */
export const SAMPLE_CARD: UpdateCardSpec = {
  v: 1,
  slides: [
    {
      title: {
        "en-US": "A raccoon in every session", "es-ES": "Un mapache en cada sesión", "fr-FR": "Un raton laveur par session",
        "de-DE": "Ein Waschbär pro Sitzung", "it-IT": "Un procione per sessione", "pt-BR": "Um guaxinim por sessão",
        "id-ID": "Rakun di setiap sesi", "ja-JP": "各セッションにアライグマ", "ko-KR": "모든 세션에 너구리가", "hi-IN": "हर सत्र में एक रैकून",
      },
      desc: {
        "en-US": "It shows what the agent does: it thinks, reads code with a magnifier and types to edit.",
        "es-ES": "Enseña lo que hace el agente: piensa, lee código con la lupa y teclea al editar.",
        "fr-FR": "Il montre ce que fait l'agent : il réfléchit, lit le code à la loupe et tape en éditant.",
        "de-DE": "Zeigt, was der Agent tut: Er denkt nach, liest Code mit der Lupe und tippt beim Bearbeiten.",
        "it-IT": "Mostra cosa fa l'agente: pensa, legge il codice con la lente e scrive mentre modifica.",
        "pt-BR": "Mostra o que o agente faz: pensa, lê código com a lupa e digita ao editar.",
        "id-ID": "Menunjukkan kerja agen: berpikir, membaca kode dengan kaca pembesar, dan mengetik.",
        "ja-JP": "エージェントの動きを見せます。考え、虫眼鏡でコードを読み、編集中はタイプします。",
        "ko-KR": "에이전트가 하는 일을 보여줍니다. 생각하고, 돋보기로 코드를 읽고, 편집할 때 타이핑해요.",
        "hi-IN": "एजेंट क्या कर रहा है, दिखाता है: सोचता है, लेंस से कोड पढ़ता है और एडिट करते समय टाइप करता है।",
      },
      scene: {
        kind: "mascot",
        steps: [
          {
            pose: "think",
            label: {
              "en-US": "Thinking…", "es-ES": "Pensando…", "fr-FR": "Réflexion…", "de-DE": "Denkt nach…", "it-IT": "Sto pensando…",
              "pt-BR": "Pensando…", "id-ID": "Berpikir…", "ja-JP": "考え中…", "ko-KR": "생각 중…", "hi-IN": "सोच रहा है…",
            },
          },
          {
            pose: "search",
            label: {
              "en-US": "Reading App.tsx", "es-ES": "Leyendo App.tsx", "fr-FR": "Lecture de App.tsx", "de-DE": "Liest App.tsx",
              "it-IT": "Legge App.tsx", "pt-BR": "Lendo App.tsx", "id-ID": "Membaca App.tsx", "ja-JP": "App.tsx を読み中",
              "ko-KR": "App.tsx 읽는 중", "hi-IN": "App.tsx पढ़ रहा है",
            },
          },
          {
            pose: "code",
            label: {
              "en-US": "Editing main.ts", "es-ES": "Editando main.ts", "fr-FR": "Édite main.ts",
              "de-DE": "Bearbeitet main.ts", "it-IT": "Modifica main.ts", "pt-BR": "Editando main.ts",
              "id-ID": "Mengedit main.ts", "ja-JP": "main.ts を編集中", "ko-KR": "main.ts 편집 중", "hi-IN": "एडिट: main.ts",
            },
          },
        ],
      },
    },
    {
      title: {
        "en-US": "It reacts to what you write", "es-ES": "Reacciona a lo que escribes", "fr-FR": "Il réagit à ce que tu écris",
        "de-DE": "Reagiert auf dich", "it-IT": "Reagisce a ciò che scrivi", "pt-BR": "Reage ao que você escreve",
        "id-ID": "Bereaksi pada tulisanmu", "ja-JP": "書いた内容に反応します", "ko-KR": "쓴 내용에 반응해요", "hi-IN": "आपके लिखे पर प्रतिक्रिया देता है",
      },
      desc: {
        "en-US": "It celebrates a thank-you, gets sad when something breaks and covers its eyes at an apology.",
        "es-ES": "Celebra un gracias, se pone triste si algo falla y se tapa los ojos con un perdón.",
        "fr-FR": "Il fête un merci, est triste quand ça casse et se cache les yeux à une excuse.",
        "de-DE": "Feiert ein Danke, ist bei Fehlern traurig und hält sich bei Sorry die Augen zu.",
        "it-IT": "Festeggia un grazie, si rattrista se qualcosa si rompe e si copre gli occhi a una scusa.",
        "pt-BR": "Comemora um obrigado, fica triste se algo falha e tapa os olhos com um desculpa.",
        "id-ID": "Senang saat diberi terima kasih, sedih saat ada error, menutup mata saat minta maaf.",
        "ja-JP": "お礼で喜び、何か壊れると悲しみ、謝ると目を隠します。",
        "ko-KR": "고맙다고 하면 축하하고, 뭔가 고장 나면 슬퍼하고, 사과하면 눈을 가려요.",
        "hi-IN": "धन्यवाद पर खुश होता है, कुछ टूटे तो उदास होता है और माफ़ी पर आँखें ढक लेता है।",
      },
      scene: {
        kind: "reactions",
        steps: [
          {
            pose: "celebrate",
            text: {
              "en-US": "thanks!", "es-ES": "¡gracias!", "fr-FR": "merci !", "de-DE": "danke!", "it-IT": "grazie!",
              "pt-BR": "obrigado!", "id-ID": "makasih!", "ja-JP": "ありがとう！", "ko-KR": "고마워!", "hi-IN": "धन्यवाद!",
            },
          },
          {
            pose: "sad",
            text: {
              "en-US": "still broken…", "es-ES": "sigue sin funcionar…", "fr-FR": "toujours cassé…", "de-DE": "geht immer noch nicht…",
              "it-IT": "ancora non va…", "pt-BR": "ainda não funciona…", "id-ID": "masih rusak…", "ja-JP": "まだ動かない…",
              "ko-KR": "아직도 안 돼…", "hi-IN": "अब भी काम नहीं करता…",
            },
          },
          {
            pose: "shy",
            text: {
              "en-US": "sorry, my bad", "es-ES": "perdón, me equivoqué", "fr-FR": "pardon, mon erreur", "de-DE": "sorry, mein Fehler",
              "it-IT": "scusa, errore mio", "pt-BR": "desculpa, foi mal", "id-ID": "maaf, salahku", "ja-JP": "ごめん、間違えた",
              "ko-KR": "미안, 내 실수야", "hi-IN": "माफ़ करना, मेरी गलती",
            },
          },
        ],
      },
    },
    {
      title: {
        "en-US": "It opens its laptop to start", "es-ES": "Abre su portátil al empezar", "fr-FR": "Il sort son portable",
        "de-DE": "Startet mit dem Laptop", "it-IT": "Apre il portatile all'inizio", "pt-BR": "Começa com o notebook",
        "id-ID": "Membuka laptop saat mulai", "ja-JP": "最初にノートPCを開きます", "ko-KR": "시작할 때 노트북을 열어요", "hi-IN": "शुरुआत में लैपटॉप खोलता है",
      },
      desc: {
        "en-US": "A new session starts with the raccoon typing once before it settles down.",
        "es-ES": "Una sesión nueva arranca con el mapache tecleando una vez antes de acomodarse.",
        "fr-FR": "Une nouvelle session démarre avec le raton qui tape une fois avant de se poser.",
        "de-DE": "Eine neue Sitzung beginnt damit, dass der Waschbär kurz tippt und sich dann setzt.",
        "it-IT": "Una nuova sessione parte con il procione che scrive una volta prima di sistemarsi.",
        "pt-BR": "Uma nova sessão começa com o guaxinim digitando uma vez antes de se acomodar.",
        "id-ID": "Sesi baru dimulai dengan rakun mengetik sekali sebelum duduk tenang.",
        "ja-JP": "新しいセッションは、アライグマが一度タイプしてから落ち着いて始まります。",
        "ko-KR": "새 세션은 너구리가 한 번 타이핑한 뒤 자리를 잡으며 시작해요.",
        "hi-IN": "नया सत्र रैकून के एक बार टाइप करने से शुरू होता है, फिर वह आराम से बैठ जाता है।",
      },
      scene: {
        kind: "mascot",
        steps: [{ pose: "intro" }],
        placeholder: {
          "en-US": "Describe a task", "es-ES": "Describe una tarea", "fr-FR": "Décris une tâche", "de-DE": "Beschreibe eine Aufgabe",
          "it-IT": "Descrivi un'attività", "pt-BR": "Descreva uma tarefa", "id-ID": "Jelaskan tugas", "ja-JP": "タスクを説明",
          "ko-KR": "작업을 설명하세요", "hi-IN": "कोई काम बताएँ",
        },
      },
    },
    {
      title: {
        "en-US": "Dictate and attach in replies", "es-ES": "Dicta y adjunta al responder", "fr-FR": "Dicte et joins en réponse",
        "de-DE": "Diktieren und anhängen", "it-IT": "Detta e allega nelle risposte", "pt-BR": "Dite e anexe nas respostas",
        "id-ID": "Dikte dan lampirkan", "ja-JP": "返信で音声入力と添付", "ko-KR": "답장에서 받아쓰기와 첨부", "hi-IN": "जवाब में बोलें और अटैच करें",
      },
      desc: {
        "en-US": "Replies to selected text get the microphone, files and pasted screenshots.",
        "es-ES": "Al responder a una selección tienes micrófono, archivos y capturas pegadas.",
        "fr-FR": "Les réponses à une sélection ont le micro, les fichiers et les captures collées.",
        "de-DE": "Antworten auf markierten Text haben Mikrofon, Dateien und eingefügte Screenshots.",
        "it-IT": "Le risposte a un testo selezionato hanno microfono, file e screenshot incollati.",
        "pt-BR": "Respostas a um texto selecionado têm microfone, arquivos e capturas coladas.",
        "id-ID": "Balasan untuk teks terpilih kini punya mikrofon, file, dan tangkapan layar.",
        "ja-JP": "選択したテキストへの返信で、マイク、ファイル、貼り付けたスクリーンショットが使えます。",
        "ko-KR": "선택한 텍스트에 답할 때 마이크, 파일, 붙여넣은 스크린샷을 쓸 수 있어요.",
        "hi-IN": "चुने हुए टेक्स्ट के जवाब में माइक, फ़ाइलें और पेस्ट किए स्क्रीनशॉट मिलते हैं।",
      },
      scene: {
        kind: "reply",
        quote: {
          "en-US": "The changes panel is slow", "es-ES": "El panel de cambios va lento", "fr-FR": "Le panneau des modifs rame",
          "de-DE": "Das Änderungsfenster ist langsam", "it-IT": "Il pannello modifiche è lento", "pt-BR": "O painel de mudanças está lento",
          "id-ID": "Panel perubahan lambat", "ja-JP": "変更パネルが遅い", "ko-KR": "변경 패널이 느려요", "hi-IN": "बदलाव पैनल धीमा है",
        },
        voice: true,
        attach: [{ icon: "image", label: "screenshot.png" }],
      },
    },
    {
      title: {
        "en-US": "Picks from the browser", "es-ES": "Elementos del navegador", "fr-FR": "Tes choix dans le navigateur",
        "de-DE": "Auswahl aus dem Browser", "it-IT": "Ciò che scegli nel browser", "pt-BR": "Elementos do navegador",
        "id-ID": "Pilihan dari browser", "ja-JP": "ブラウザで選んだ要素", "ko-KR": "브라우저에서 고른 요소", "hi-IN": "ब्राउज़र से चुने एलिमेंट",
      },
      desc: {
        "en-US": "Elements you pick in the browser and their annotated screenshots go into that reply.",
        "es-ES": "Los elementos que eliges en el navegador y sus capturas anotadas van a esa respuesta.",
        "fr-FR": "Les éléments choisis dans le navigateur et leurs captures annotées vont dans la réponse.",
        "de-DE": "Im Browser gewählte Elemente und ihre Screenshots landen in der Antwort.",
        "it-IT": "Gli elementi scelti nel browser e i loro screenshot annotati finiscono nella risposta.",
        "pt-BR": "Os elementos escolhidos no navegador e suas capturas anotadas vão para a resposta.",
        "id-ID": "Elemen yang kamu pilih di browser dan tangkapan layarnya masuk ke balasan.",
        "ja-JP": "ブラウザで選んだ要素と注釈付きスクリーンショットがその返信に入ります。",
        "ko-KR": "브라우저에서 고른 요소와 주석 단 스크린샷이 그 답장에 들어가요.",
        "hi-IN": "ब्राउज़र में चुने एलिमेंट और उनके एनोटेट स्क्रीनशॉट उसी जवाब में जाते हैं।",
      },
      scene: {
        kind: "browser",
        url: "localhost:1420/settings",
        element: {
          "en-US": "Save changes", "es-ES": "Guardar cambios", "fr-FR": "Enregistrer", "de-DE": "Speichern", "it-IT": "Salva modifiche",
          "pt-BR": "Salvar alterações", "id-ID": "Simpan", "ja-JP": "変更を保存", "ko-KR": "변경 저장", "hi-IN": "बदलाव सहेजें",
        },
        selector: "button.primary",
      },
    },
    {
      title: {
        "en-US": "And also", "es-ES": "Y además", "fr-FR": "Et aussi", "de-DE": "Außerdem", "it-IT": "E inoltre",
        "pt-BR": "E também", "id-ID": "Selain itu", "ja-JP": "そのほか", "ko-KR": "그 밖에", "hi-IN": "और भी",
      },
      desc: {
        "en-US": "2 improvements in this version.", "es-ES": "2 mejoras en esta versión.", "fr-FR": "2 améliorations dans cette version.",
        "de-DE": "2 Verbesserungen in dieser Version.", "it-IT": "2 miglioramenti in questa versione.", "pt-BR": "2 melhorias nesta versão.",
        "id-ID": "2 peningkatan di versi ini.", "ja-JP": "このバージョンの改善点は2つ。", "ko-KR": "이번 버전의 개선 사항 2가지.", "hi-IN": "इस संस्करण में 2 सुधार।",
      },
      scene: {
        kind: "list",
        items: [
          {
            tag: "improved",
            text: {
              "en-US": "Waves when it needs your answer and sleeps when idle.",
              "es-ES": "Saluda cuando le toca responderte y se duerme si no pasa nada.",
              "fr-FR": "Salue quand il attend ta réponse et dort s'il ne se passe rien.",
              "de-DE": "Winkt, wenn es deine Antwort braucht, und schläft bei Ruhe.",
              "it-IT": "Saluta quando serve una risposta e dorme se è inattivo.",
              "pt-BR": "Acena quando precisa de você e dorme se nada acontece.",
              "id-ID": "Melambai saat butuh jawabanmu dan tidur saat diam.",
              "ja-JP": "返事が必要なときに手を振り、何もないと眠ります。",
              "ko-KR": "답이 필요하면 손을 흔들고, 한가하면 잠들어요.",
              "hi-IN": "जवाब चाहिए तो हाथ हिलाता है, खाली हो तो सो जाता है।",
            },
          },
          {
            tag: "improved",
            text: {
              "en-US": "Clicking the browser no longer closes your reply.",
              "es-ES": "Hacer clic en el navegador ya no cierra tu respuesta.",
              "fr-FR": "Cliquer dans le navigateur ne ferme plus ta réponse.",
              "de-DE": "Ein Klick in den Browser schließt die Antwort nicht mehr.",
              "it-IT": "Cliccare nel browser non chiude più la risposta.",
              "pt-BR": "Clicar no navegador não fecha mais sua resposta.",
              "id-ID": "Klik di browser tak lagi menutup balasanmu.",
              "ja-JP": "ブラウザをクリックしても返信が閉じなくなりました。",
              "ko-KR": "브라우저를 클릭해도 답장이 닫히지 않아요.",
              "hi-IN": "ब्राउज़र पर क्लिक करने से अब जवाब बंद नहीं होता।",
            },
          },
        ],
      },
    },
  ],
};
