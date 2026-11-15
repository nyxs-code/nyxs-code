import type { UpdateCardSpec } from "@/lib/updateCard";

export interface ChangelogEntry {
  version: string;
  date: string;
  added?: string[];
  fixed?: string[];
  improved?: string[];
  /** The slides of the card that offers this version, with their demos (skill
   *  `nyxs-update-card`). Plain JSON-like literal: `scripts/release-notes.mjs` evaluates it. */
  card?: UpdateCardSpec;
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.8.57",
    date: "November 14, 2026",
    added: [
      "Nyxs is open source under the MIT license: the code, the issues and the releases are at github.com/nyxs-code/nyxs-code.",
      "Each session in Recents has a menu: pin it, mark it unread, group it in sections, move it to another project, copy it as Markdown or for another model, schedule a task from it, or select several to archive or delete.",
    ],
    improved: [
      "A cloned project's Claude Code settings (hooks, allow rules, environment variables) and its MCP servers stay off until you trust the folder, as Nyxs' own project settings already did.",
      "A theme changed in one session now updates in the other open sessions.",
      "Clicking a path to a program in the chat no longer runs it, and network paths in a reply are never looked up.",
      "Plugin and skill catalogs are downloaded with their certificates checked.",
      "The installer shows Nyxs Code as the publisher.",
    ],
    fixed: [
      "Moving or deleting a video project no longer fails on Windows while its player is running.",
    ],
    card: {
      v: 1,
      slides: [
        {
          title: {
            "en-US": "Nyxs is open source", "es-ES": "Nyxs es de código abierto", "fr-FR": "Nyxs devient open source",
            "de-DE": "Nyxs ist Open Source", "it-IT": "Nyxs è open source", "pt-BR": "Nyxs é código aberto",
            "id-ID": "Nyxs kini open source", "ja-JP": "Nyxsがオープンソースに", "ko-KR": "Nyxs가 오픈 소스가 됐어요", "hi-IN": "Nyxs अब ओपन सोर्स है",
          },
          desc: {
            "en-US": "The code is on GitHub under the MIT license: read it, build it or send a change.",
            "es-ES": "El código está en GitHub con licencia MIT: léelo, compílalo o propón cambios.",
            "fr-FR": "Le code est sur GitHub sous licence MIT : lis-le, compile-le ou propose un changement.",
            "de-DE": "Der Code ist auf GitHub (MIT-Lizenz): lesen, bauen, mitmachen.",
            "it-IT": "Il codice è su GitHub con licenza MIT: leggilo, compilalo o proponi modifiche.",
            "pt-BR": "O código está no GitHub com licença MIT: leia, compile ou sugira mudanças.",
            "id-ID": "Kodenya ada di GitHub dengan lisensi MIT: baca, build, atau kirim perubahan.",
            "ja-JP": "コードはMITライセンスでGitHubに公開。読む、ビルドする、変更を送るのも自由です。",
            "ko-KR": "코드는 MIT 라이선스로 GitHub에 있어요. 읽고, 빌드하고, 변경을 보낼 수 있어요.",
            "hi-IN": "कोड MIT लाइसेंस के साथ GitHub पर है: पढ़ें, बिल्ड करें या बदलाव भेजें।",
          },
          scene: {
            kind: "terminal",
            lines: [
              { kind: "cmd", text: "git clone …/nyxs-code" },
              { kind: "out", text: "Cloning into 'nyxs-code'..." },
              { kind: "ok", text: "MIT License" },
            ],
          },
        },
        {
          title: {
            "en-US": "A menu for each session", "es-ES": "Un menú para cada sesión", "fr-FR": "Un menu par session",
            "de-DE": "Ein Menü pro Sitzung", "it-IT": "Un menu per ogni sessione", "pt-BR": "Um menu para cada sessão",
            "id-ID": "Menu untuk tiap sesi", "ja-JP": "セッションごとのメニュー", "ko-KR": "세션마다 메뉴가 생겼어요", "hi-IN": "हर सत्र का अपना मेनू",
          },
          desc: {
            "en-US": "Pin sessions, group them in sections, move them to another project or copy them.",
            "es-ES": "Fija sesiones, agrúpalas en secciones, muévelas a otro proyecto o cópialas.",
            "fr-FR": "Épingle, range en sections, déplace vers un autre projet ou copie tes sessions.",
            "de-DE": "Sitzungen anheften, in Abschnitte sortieren, verschieben oder kopieren.",
            "it-IT": "Fissa le sessioni, raggruppale in sezioni, spostale in un altro progetto o copiale.",
            "pt-BR": "Fixe sessões, agrupe em seções, mova para outro projeto ou copie.",
            "id-ID": "Sematkan sesi, kelompokkan dalam bagian, pindahkan ke proyek lain, atau salin.",
            "ja-JP": "セッションを固定、セクションに整理、別のプロジェクトへ移動、コピーもできます。",
            "ko-KR": "세션을 고정하고, 섹션으로 묶고, 다른 프로젝트로 옮기거나 복사할 수 있어요.",
            "hi-IN": "सत्र पिन करें, सेक्शन में रखें, दूसरे प्रोजेक्ट में ले जाएँ या कॉपी करें।",
          },
          scene: { kind: "icon", icon: "layers" },
        },
        {
          title: {
            "en-US": "Safer cloned projects", "es-ES": "Proyectos ajenos, seguros", "fr-FR": "Projets clonés plus sûrs",
            "de-DE": "Sicher bei fremden Repos", "it-IT": "Progetti clonati sicuri", "pt-BR": "Projetos clonados seguros",
            "id-ID": "Repo kloningan lebih aman", "ja-JP": "クローンした作業も安全に", "ko-KR": "복제한 프로젝트도 안전하게", "hi-IN": "क्लोन प्रोजेक्ट अब सुरक्षित",
          },
          desc: {
            "en-US": "A repo's hooks, MCP servers and allow rules don't run until you trust its folder.",
            "es-ES": "Los hooks, servidores MCP y reglas de un repo no se aplican hasta que confíes en él.",
            "fr-FR": "Les hooks, serveurs MCP et règles d'un dépôt attendent que tu lui fasses confiance.",
            "de-DE": "Hooks, MCP-Server und Regeln eines Repos greifen erst, wenn du ihm vertraust.",
            "it-IT": "Hook, server MCP e regole di un repo partono solo quando ti fidi della cartella.",
            "pt-BR": "Hooks, servidores MCP e regras de um repo só valem depois que você confiar nele.",
            "id-ID": "Hook, server MCP, dan aturan repo baru berjalan setelah kamu memercayai foldernya.",
            "ja-JP": "リポジトリのフック、MCPサーバー、許可ルールは、信頼するまで動きません。",
            "ko-KR": "저장소의 훅, MCP 서버, 허용 규칙은 폴더를 신뢰하기 전까지 실행되지 않아요.",
            "hi-IN": "रिपो के हुक, MCP सर्वर और नियम तभी चलते हैं जब आप फ़ोल्डर पर भरोसा करें।",
          },
          scene: { kind: "icon", icon: "shield" },
        },
        {
          title: {
            "en-US": "And also", "es-ES": "Y además", "fr-FR": "Et aussi", "de-DE": "Außerdem", "it-IT": "E inoltre",
            "pt-BR": "E também", "id-ID": "Selain itu", "ja-JP": "そのほか", "ko-KR": "그 밖에", "hi-IN": "और भी",
          },
          desc: {
            "en-US": "2 more changes in this version.", "es-ES": "2 cambios más en esta versión.", "fr-FR": "2 autres changements dans cette version.",
            "de-DE": "2 weitere Änderungen in dieser Version.", "it-IT": "Altre 2 novità in questa versione.", "pt-BR": "Mais 2 mudanças nesta versão.",
            "id-ID": "2 perubahan lain di versi ini.", "ja-JP": "このバージョンのその他の変更2つ。", "ko-KR": "이번 버전의 다른 변경 사항 2가지.", "hi-IN": "इस संस्करण में 2 और बदलाव।",
          },
          scene: {
            kind: "list",
            items: [
              {
                tag: "improved",
                text: {
                  "en-US": "A theme changed in one session now updates in the others.",
                  "es-ES": "Un tema cambiado en una sesión se actualiza en las demás.",
                  "fr-FR": "Un thème changé dans une session s'applique aux autres.",
                  "de-DE": "Ein geändertes Theme gilt sofort auch in anderen Sitzungen.",
                  "it-IT": "Un tema cambiato in una sessione si aggiorna nelle altre.",
                  "pt-BR": "Um tema mudado numa sessão agora atualiza nas outras.",
                  "id-ID": "Tema yang diubah di satu sesi kini ikut berubah di sesi lain.",
                  "ja-JP": "変えたテーマがほかのセッションにも反映されます。",
                  "ko-KR": "한 세션에서 바꾼 테마가 다른 세션에도 바로 적용돼요.",
                  "hi-IN": "एक सत्र में बदली थीम अब बाकी सत्रों में भी दिखती है।",
                },
              },
              {
                tag: "fixed",
                text: {
                  "en-US": "Moving or deleting a video project no longer fails on Windows.",
                  "es-ES": "Mover o borrar un proyecto de vídeo ya no falla en Windows.",
                  "fr-FR": "Supprimer ou renommer un projet vidéo marche sous Windows.",
                  "de-DE": "Videoprojekte lassen sich unter Windows wieder löschen.",
                  "it-IT": "Eliminare un progetto video ora funziona anche su Windows.",
                  "pt-BR": "Mover ou apagar um projeto de vídeo não falha mais no Windows.",
                  "id-ID": "Memindah atau menghapus proyek video tak lagi gagal di Windows.",
                  "ja-JP": "Windowsで動画プロジェクトの移動や削除が失敗しなくなりました。",
                  "ko-KR": "Windows에서 동영상 프로젝트 이동·삭제가 더 이상 실패하지 않아요.",
                  "hi-IN": "Windows पर वीडियो प्रोजेक्ट हटाना या ले जाना अब विफल नहीं होता।",
                },
              },
            ],
          },
        },
      ],
    },
  },
  {
    version: "0.8.56",
    date: "November 14, 2026",
    added: [
      "Custom themes: describe the look you want and the agent writes a theme with its own colors and an animated background, in Claude Code's mod format.",
      "Twenty animated backgrounds come installed with Anthropic's theme-examples plugin: type /custom-theme to pick one for a project or for one session.",
      "Settings › General › Title generation chooses who names new sessions: automatically, Codex, Claude Haiku or nobody, with a button to test it.",
      "Settings › About shows your version and its updates, where your data lives and the details to attach to a bug report.",
    ],
    improved: [
      "While the agent uses your computer, a glowing rainbow frame lights the edges of the screen and gathers where it clicks.",
      "While the agent uses your computer, Nyxs moves to a small window in the bottom right corner so you can watch it work, and goes back when it's done.",
      "The dropdowns in Settings open the app's own menu instead of the system's list.",
      "In a narrow window the title bar hides the music player and the history arrows instead of showing scrollbars.",
    ],
    fixed: [
      "The description of a / command stays on screen and no longer moves the chat.",
      "A skill named like a built-in command, such as commit, is listed once.",
    ],
    card: {
      v: 1,
      slides: [
        {
          title: {
            "en-US": "Themes made by the agent", "es-ES": "Temas que hace el agente", "fr-FR": "Thèmes créés par l'agent",
            "de-DE": "Themes vom Agenten", "it-IT": "Temi creati dall'agente", "pt-BR": "Temas feitos pelo agente",
            "id-ID": "Tema buatan agen", "ja-JP": "エージェントが作るテーマ", "ko-KR": "에이전트가 만드는 테마", "hi-IN": "एजेंट की बनाई थीम",
          },
          desc: {
            "en-US": "Describe a look and the agent writes a theme with colors and an animated background.",
            "es-ES": "Describe un estilo y el agente crea un tema con colores y un fondo animado.",
            "fr-FR": "Décris un style et l'agent crée un thème avec couleurs et fond animé.",
            "de-DE": "Beschreib einen Stil: Der Agent baut ein Theme mit Farben und Animation.",
            "it-IT": "Descrivi uno stile e l'agente crea un tema con colori e sfondo animato.",
            "pt-BR": "Descreva um estilo e o agente cria um tema com cores e fundo animado.",
            "id-ID": "Jelaskan gayanya dan agen membuat tema dengan warna dan latar animasi.",
            "ja-JP": "見た目を伝えると、色と動く背景つきのテーマを作ります。",
            "ko-KR": "원하는 스타일을 말하면 색과 움직이는 배경이 있는 테마를 만들어요.",
            "hi-IN": "स्टाइल बताइए, एजेंट रंगों और एनिमेटेड बैकग्राउंड वाली थीम बनाएगा।",
          },
          scene: {
            kind: "reactions",
            steps: [
              {
                pose: "code",
                text: {
                  "en-US": "an ocean theme please", "es-ES": "un tema de mar", "fr-FR": "un thème océan", "de-DE": "ein meer-theme bitte",
                  "it-IT": "un tema mare", "pt-BR": "um tema de mar", "id-ID": "tema laut dong", "ja-JP": "海っぽいテーマにして",
                  "ko-KR": "바다 테마로 해줘", "hi-IN": "समुद्र वाली थीम",
                },
              },
              {
                pose: "celebrate",
                text: {
                  "en-US": "love it!", "es-ES": "¡me encanta!", "fr-FR": "j'adore !", "de-DE": "super!", "it-IT": "che bello!",
                  "pt-BR": "amei!", "id-ID": "keren!", "ja-JP": "最高！", "ko-KR": "멋져!", "hi-IN": "बढ़िया!",
                },
              },
            ],
          },
        },
        {
          title: {
            "en-US": "20 animated backgrounds", "es-ES": "20 fondos animados", "fr-FR": "20 fonds animés",
            "de-DE": "20 bewegte Hintergründe", "it-IT": "20 sfondi animati", "pt-BR": "20 fundos animados",
            "id-ID": "20 latar animasi", "ja-JP": "20種類の動く背景", "ko-KR": "움직이는 배경 20가지", "hi-IN": "20 एनिमेटेड बैकग्राउंड",
          },
          desc: {
            "en-US": "Type /custom-theme to pick one for a project or just this session.",
            "es-ES": "Escribe /custom-theme y elige uno para el proyecto o solo esta sesión.",
            "fr-FR": "Tape /custom-theme et choisis-en un pour le projet ou cette session.",
            "de-DE": "Tippe /custom-theme und wähle einen für das Projekt oder die Sitzung.",
            "it-IT": "Scrivi /custom-theme e scegline uno per il progetto o questa sessione.",
            "pt-BR": "Digite /custom-theme e escolha um para o projeto ou esta sessão.",
            "id-ID": "Ketik /custom-theme dan pilih satu untuk proyek atau sesi ini.",
            "ja-JP": "/custom-theme でプロジェクトやこのセッションに設定できます。",
            "ko-KR": "/custom-theme로 프로젝트나 이 세션에 적용할 수 있어요.",
            "hi-IN": "/custom-theme लिखें और प्रोजेक्ट या इस सत्र के लिए चुनें।",
          },
          scene: { kind: "icon", icon: "palette" },
        },
        {
          title: {
            "en-US": "Watch it use your PC", "es-ES": "Míralo usar tu PC", "fr-FR": "Regarde-le sur ton PC",
            "de-DE": "Sieh ihm am PC zu", "it-IT": "Guardalo usare il PC", "pt-BR": "Veja ele usar seu PC",
            "id-ID": "Lihat agen pakai PC-mu", "ja-JP": "PC操作を見守れる", "ko-KR": "PC 조작을 지켜보세요", "hi-IN": "PC पर काम देखें",
          },
          desc: {
            "en-US": "Nyxs moves to a corner and a glowing frame lights the screen while the agent works.",
            "es-ES": "Nyxs se va a una esquina y un marco de luz rodea la pantalla mientras trabaja.",
            "fr-FR": "Nyxs se range dans un coin et un cadre lumineux entoure l'écran.",
            "de-DE": "Nyxs rückt in die Ecke, ein Leuchtrahmen zeigt, dass der Agent arbeitet.",
            "it-IT": "Nyxs si sposta in un angolo e una cornice di luce avvolge lo schermo.",
            "pt-BR": "O Nyxs vai para um canto e uma moldura de luz cerca a tela.",
            "id-ID": "Nyxs pindah ke pojok dan bingkai bercahaya mengelilingi layar.",
            "ja-JP": "作業中はNyxsが隅に移動し、光る枠が画面を囲みます。",
            "ko-KR": "작업하는 동안 Nyxs는 구석으로 가고 빛나는 테두리가 화면을 감싸요.",
            "hi-IN": "काम के दौरान Nyxs कोने में जाता है और स्क्रीन पर चमकता फ्रेम दिखता है।",
          },
          scene: {
            kind: "mascot",
            steps: [
              {
                pose: "search",
                label: {
                  "en-US": "Opening Discord", "es-ES": "Abriendo Discord", "fr-FR": "Ouvre Discord", "de-DE": "Öffne Discord",
                  "it-IT": "Apro Discord", "pt-BR": "Abrindo o Discord", "id-ID": "Membuka Discord", "ja-JP": "Discordを起動中",
                  "ko-KR": "Discord 여는 중", "hi-IN": "Discord खोल रहा है",
                },
              },
              {
                pose: "code",
                label: {
                  "en-US": "Joining the channel", "es-ES": "Entrando al canal", "fr-FR": "Rejoint le salon", "de-DE": "Trete dem Kanal bei",
                  "it-IT": "Entro nel canale", "pt-BR": "Entrando no canal", "id-ID": "Masuk ke kanal", "ja-JP": "チャンネルに参加中",
                  "ko-KR": "채널 들어가는 중", "hi-IN": "चैनल में जुड़ रहा है",
                },
              },
              {
                pose: "celebrate",
                label: {
                  "en-US": "Done", "es-ES": "Listo", "fr-FR": "C'est fait", "de-DE": "Fertig", "it-IT": "Fatto",
                  "pt-BR": "Pronto", "id-ID": "Selesai", "ja-JP": "完了", "ko-KR": "완료", "hi-IN": "हो गया",
                },
              },
            ],
          },
        },
        {
          title: {
            "en-US": "Titles your way", "es-ES": "Títulos a tu manera", "fr-FR": "Des titres à ta façon",
            "de-DE": "Titel nach Wunsch", "it-IT": "Titoli a modo tuo", "pt-BR": "Títulos do seu jeito",
            "id-ID": "Judul sesuai pilihanmu", "ja-JP": "タイトルを自由に", "ko-KR": "제목 생성 방식 선택", "hi-IN": "शीर्षक आपकी पसंद से",
          },
          desc: {
            "en-US": "Pick Codex, Claude Haiku or automatic to name new sessions, and test it.",
            "es-ES": "Elige Codex, Claude Haiku o automático para titular sesiones, y pruébalo.",
            "fr-FR": "Choisis Codex, Claude Haiku ou automatique pour nommer les sessions.",
            "de-DE": "Wähle Codex, Claude Haiku oder automatisch für Sitzungstitel.",
            "it-IT": "Scegli Codex, Claude Haiku o automatico per i titoli delle sessioni.",
            "pt-BR": "Escolha Codex, Claude Haiku ou automático para nomear as sessões.",
            "id-ID": "Pilih Codex, Claude Haiku, atau otomatis untuk judul sesi baru.",
            "ja-JP": "新しいセッションのタイトルをCodexやClaude Haikuで付けられます。",
            "ko-KR": "새 세션 제목을 Codex, Claude Haiku 또는 자동으로 붙여요.",
            "hi-IN": "नए सत्रों के शीर्षक Codex, Claude Haiku या अपने-आप दें।",
          },
          scene: { kind: "icon", icon: "message" },
        },
        {
          title: {
            "en-US": "And also", "es-ES": "Y además", "fr-FR": "Et aussi", "de-DE": "Außerdem", "it-IT": "E inoltre",
            "pt-BR": "E também", "id-ID": "Selain itu", "ja-JP": "そのほか", "ko-KR": "그 밖에", "hi-IN": "और भी",
          },
          desc: {
            "en-US": "2 more changes in this version.", "es-ES": "2 cambios más en esta versión.", "fr-FR": "2 autres changements dans cette version.",
            "de-DE": "2 weitere Änderungen in dieser Version.", "it-IT": "Altre 2 novità in questa versione.", "pt-BR": "Mais 2 mudanças nesta versão.",
            "id-ID": "2 perubahan lain di versi ini.", "ja-JP": "このバージョンのその他の変更2つ。", "ko-KR": "이번 버전의 다른 변경 사항 2가지.", "hi-IN": "इस संस्करण में 2 और बदलाव।",
          },
          scene: {
            kind: "list",
            items: [
              {
                tag: "new",
                text: {
                  "en-US": "An About page in Settings shows your version and system.",
                  "es-ES": "Ajustes tiene una página Acerca de con tu versión y sistema.",
                  "fr-FR": "Une page À propos montre ta version et ton système.",
                  "de-DE": "Neue Seite „Über“ mit Version und System in den Einstellungen.",
                  "it-IT": "Una pagina Info nelle Impostazioni mostra versione e sistema.",
                  "pt-BR": "Uma página Sobre nos Ajustes mostra sua versão e sistema.",
                  "id-ID": "Halaman Tentang di Pengaturan menampilkan versi dan sistem.",
                  "ja-JP": "設定に「情報」ページ。バージョンとシステムを確認できます。",
                  "ko-KR": "설정의 정보 페이지에서 버전과 시스템을 볼 수 있어요.",
                  "hi-IN": "सेटिंग्स में अबाउट पेज: आपका संस्करण और सिस्टम।",
                },
              },
              {
                tag: "fixed",
                text: {
                  "en-US": "The / menu stays on screen and no longer repeats commands.",
                  "es-ES": "El menú / ya no se sale de pantalla ni repite comandos.",
                  "fr-FR": "Le menu / reste à l'écran et ne répète plus les commandes.",
                  "de-DE": "Das /-Menü bleibt im Bild und zeigt Befehle nicht doppelt.",
                  "it-IT": "Il menu / resta nello schermo e non ripete i comandi.",
                  "pt-BR": "O menu / fica na tela e não repete mais comandos.",
                  "id-ID": "Menu / tetap di layar dan tak lagi mengulang perintah.",
                  "ja-JP": "/メニューが画面からはみ出さず、重複も出なくなりました。",
                  "ko-KR": "/ 메뉴가 화면 밖으로 나가지 않고 중복도 사라졌어요.",
                  "hi-IN": "/ मेनू अब स्क्रीन पर रहता है और दोहराता नहीं।",
                },
              },
            ],
          },
        },
      ],
    },
  },
  {
    version: "0.8.55",
    date: "November 13, 2026",
    added: [
      "A new orangutan mascot replaces the raccoon, with its own animation for each thing the agent does: thinking, reading, editing, celebrating, napping and more.",
      "Dictate and watch your words appear in the message box as you speak, in any language; the final transcript replaces them when you stop.",
    ],
    improved: [
      "The mascot is sharper and a little bigger, and moves from one animation to the next with a soft fade instead of a cut.",
      "When live dictation isn't available, the microphone records your message and transcribes it as before.",
      "The next-message suggestion no longer shows a Tab chip; Tab still takes it.",
    ],
    card: {
      v: 1,
      slides: [
        {
          title: {
            "en-US": "Meet the new orangutan", "es-ES": "Conoce al nuevo orangután", "fr-FR": "Un nouvel orang-outan",
            "de-DE": "Der neue Orang-Utan", "it-IT": "Ecco il nuovo orango", "pt-BR": "O novo orangotango",
            "id-ID": "Maskot orangutan baru", "ja-JP": "新しいオランウータン", "ko-KR": "새 오랑우탄 마스코트", "hi-IN": "नया ओरांगुटान मैस्कॉट",
          },
          desc: {
            "en-US": "It replaces the raccoon, with its own animation for each thing the agent does.",
            "es-ES": "Sustituye al mapache, con una animación para cada cosa que hace el agente.",
            "fr-FR": "Il remplace le raton laveur, avec une animation pour chaque action de l'agent.",
            "de-DE": "Er ersetzt den Waschbären, mit einer Animation für alles, was der Agent tut.",
            "it-IT": "Sostituisce il procione, con un'animazione per ogni cosa che fa l'agente.",
            "pt-BR": "Substitui o guaxinim, com uma animação para cada coisa que o agente faz.",
            "id-ID": "Menggantikan rakun, dengan animasi untuk setiap hal yang dilakukan agen.",
            "ja-JP": "アライグマに代わって登場。エージェントの動きごとにアニメーションします。",
            "ko-KR": "너구리 대신 등장해, 에이전트가 하는 일마다 다른 애니메이션을 보여줘요.",
            "hi-IN": "यह रैकून की जगह लेता है, एजेंट के हर काम के लिए अलग एनिमेशन के साथ।",
          },
          scene: { kind: "icon", icon: "sparkles" },
        },
        {
          title: {
            "en-US": "Dictate in real time", "es-ES": "Dicta en tiempo real", "fr-FR": "Dicte en temps réel",
            "de-DE": "Diktieren in Echtzeit", "it-IT": "Detta in tempo reale", "pt-BR": "Dite em tempo real",
            "id-ID": "Dikte secara langsung", "ja-JP": "リアルタイムで音声入力", "ko-KR": "실시간 음성 입력", "hi-IN": "बोलते-बोलते लिखें",
          },
          desc: {
            "en-US": "Your words appear in the message box as you speak, in any language.",
            "es-ES": "Tus palabras aparecen en el cuadro mientras hablas, en cualquier idioma.",
            "fr-FR": "Tes mots s'écrivent pendant que tu parles, dans n'importe quelle langue.",
            "de-DE": "Deine Worte erscheinen schon beim Sprechen, in jeder Sprache.",
            "it-IT": "Le parole compaiono nella casella mentre parli, in qualsiasi lingua.",
            "pt-BR": "Suas palavras aparecem na caixa enquanto você fala, em qualquer idioma.",
            "id-ID": "Kata-katamu muncul di kotak pesan saat kamu bicara, dalam bahasa apa pun.",
            "ja-JP": "話すそばから入力欄に言葉が表示されます。どの言語でも使えます。",
            "ko-KR": "말하는 동안 입력창에 바로 글자가 나타나요. 어떤 언어든 돼요.",
            "hi-IN": "बोलते ही आपके शब्द संदेश बॉक्स में दिखते हैं, किसी भी भाषा में।",
          },
          scene: {
            kind: "reply",
            quote: {
              "en-US": "Add a dark mode to settings", "es-ES": "Añade un modo oscuro", "fr-FR": "Ajoute un mode sombre",
              "de-DE": "Füge einen Dunkelmodus hinzu", "it-IT": "Aggiungi una modalità scura", "pt-BR": "Adicione um modo escuro",
              "id-ID": "Tambahkan mode gelap", "ja-JP": "ダークモードを追加して", "ko-KR": "다크 모드를 추가해 줘", "hi-IN": "डार्क मोड जोड़ दो",
            },
            voice: true,
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
                  "en-US": "The mascot is sharper and fades softly between moods.",
                  "es-ES": "La mascota se ve más nítida y cambia de gesto con un fundido.",
                  "fr-FR": "La mascotte est plus nette et change d'humeur en fondu.",
                  "de-DE": "Das Maskottchen ist schärfer und wechselt sanft die Pose.",
                  "it-IT": "La mascotte è più nitida e cambia posa con una dissolvenza.",
                  "pt-BR": "O mascote está mais nítido e muda de pose suavemente.",
                  "id-ID": "Maskot lebih tajam dan berganti pose dengan halus.",
                  "ja-JP": "マスコットがより鮮明に。ポーズはなめらかに切り替わります。",
                  "ko-KR": "마스코트가 더 선명해지고 동작이 부드럽게 바뀌어요.",
                  "hi-IN": "मैस्कॉट अब ज़्यादा साफ़ है और मुद्रा धीरे से बदलता है।",
                },
              },
              {
                tag: "improved",
                text: {
                  "en-US": "The next-message suggestion no longer shows a Tab chip.",
                  "es-ES": "La sugerencia del siguiente mensaje ya no muestra el chip Tab.",
                  "fr-FR": "La suggestion du message suivant n'affiche plus la puce Tab.",
                  "de-DE": "Der Vorschlag für die nächste Nachricht zeigt kein Tab mehr.",
                  "it-IT": "Il suggerimento del messaggio successivo non mostra più Tab.",
                  "pt-BR": "A sugestão da próxima mensagem não mostra mais o Tab.",
                  "id-ID": "Saran pesan berikutnya tak lagi menampilkan chip Tab.",
                  "ja-JP": "次のメッセージの候補にTabの表示が出なくなりました。",
                  "ko-KR": "다음 메시지 제안에 Tab 표시가 더 이상 나오지 않아요.",
                  "hi-IN": "अगले संदेश के सुझाव में अब Tab चिप नहीं दिखती।",
                },
              },
            ],
          },
        },
      ],
    },
  },
  {
    version: "0.8.54",
    date: "November 12, 2026",
    added: [
      "Choose the notification sound in Settings › General: 14 sounds or none, and each one plays as you pick it.",
      "The card that offers a new version shows each novelty with a small animated demo in your language, starting with the next update.",
    ],
    improved: [
      "While the model writes, each new word comes in blurred and clears, instead of appearing next to a pulsing bar.",
      "The restart message after an update is shorter and fits on one line in every language.",
    ],
    card: {
      v: 1,
      slides: [
        {
          title: {
            "en-US": "Pick a notification sound", "es-ES": "Elige el sonido de aviso", "fr-FR": "Choisis le son des alertes",
            "de-DE": "Wähle deinen Hinweiston", "it-IT": "Scegli il suono degli avvisi", "pt-BR": "Escolha o som dos avisos",
            "id-ID": "Pilih suara notifikasi", "ja-JP": "通知音を選べます", "ko-KR": "알림음을 고를 수 있어요", "hi-IN": "सूचना की ध्वनि चुनें",
          },
          desc: {
            "en-US": "14 sounds, or none, in Settings. Each one plays as you pick it.",
            "es-ES": "14 sonidos, o ninguno, en Ajustes. Cada uno suena al elegirlo.",
            "fr-FR": "14 sons, ou aucun, dans les réglages. Chacun se joue quand tu le choisis.",
            "de-DE": "14 Töne oder keiner, in den Einstellungen. Jeder spielt, wenn du ihn wählst.",
            "it-IT": "14 suoni, o nessuno, nelle impostazioni. Ognuno suona quando lo scegli.",
            "pt-BR": "14 sons, ou nenhum, nas configurações. Cada um toca ao ser escolhido.",
            "id-ID": "14 suara, atau tanpa suara, di pengaturan. Tiap suara diputar saat dipilih.",
            "ja-JP": "設定で14種類の音か無音を選べます。選ぶとその場で鳴ります。",
            "ko-KR": "설정에서 14가지 소리나 무음을 고를 수 있고, 고르면 바로 들려요.",
            "hi-IN": "सेटिंग्स में 14 ध्वनियाँ या कोई नहीं। चुनते ही ध्वनि बजती है।",
          },
          scene: { kind: "icon", icon: "bell" },
        },
        {
          title: {
            "en-US": "Replies fade in as written", "es-ES": "Respuestas más suaves", "fr-FR": "Des réponses plus fluides",
            "de-DE": "Weichere Antworten", "it-IT": "Risposte più fluide", "pt-BR": "Respostas mais suaves",
            "id-ID": "Balasan lebih halus", "ja-JP": "返信がなめらかに表示", "ko-KR": "답변이 부드럽게 나타나요", "hi-IN": "जवाब धीरे-धीरे उभरते हैं",
          },
          desc: {
            "en-US": "While the model writes, each new word comes in blurred and clears.",
            "es-ES": "Mientras el modelo escribe, cada palabra nueva entra borrosa y se aclara.",
            "fr-FR": "Pendant que le modèle écrit, chaque mot arrive flou puis devient net.",
            "de-DE": "Während das Modell schreibt, erscheint jedes neue Wort erst unscharf, dann klar.",
            "it-IT": "Mentre il modello scrive, ogni parola entra sfocata e poi si schiarisce.",
            "pt-BR": "Enquanto o modelo escreve, cada palavra entra desfocada e fica nítida.",
            "id-ID": "Saat model menulis, tiap kata baru muncul buram lalu jelas.",
            "ja-JP": "モデルが書いている間、新しい単語はぼやけて現れ、くっきりします。",
            "ko-KR": "모델이 쓰는 동안 새 단어가 흐릿하게 나타났다가 선명해져요.",
            "hi-IN": "मॉडल के लिखते समय हर नया शब्द धुंधला आता है और फिर साफ़ होता है।",
          },
          scene: { kind: "icon", icon: "message" },
        },
        {
          title: {
            "en-US": "A new update card", "es-ES": "Una nueva tarjeta de versión", "fr-FR": "Nouvelle carte de version",
            "de-DE": "Neue Update-Karte", "it-IT": "Nuova scheda novità", "pt-BR": "Novo cartão de atualização",
            "id-ID": "Kartu pembaruan baru", "ja-JP": "新しいアップデートカード", "ko-KR": "새 업데이트 카드", "hi-IN": "नया अपडेट कार्ड",
          },
          desc: {
            "en-US": "From the next version on, each novelty comes with a small animated demo.",
            "es-ES": "Desde la próxima versión, cada novedad llega con una pequeña demo animada.",
            "fr-FR": "Dès la prochaine version, chaque nouveauté arrive avec une petite démo animée.",
            "de-DE": "Ab der nächsten Version kommt jede Neuheit mit einer kleinen animierten Demo.",
            "it-IT": "Dalla prossima versione, ogni novità arriva con una piccola demo animata.",
            "pt-BR": "A partir da próxima versão, cada novidade vem com uma pequena demo animada.",
            "id-ID": "Mulai versi berikutnya, tiap fitur baru hadir dengan demo animasi kecil.",
            "ja-JP": "次のバージョンから、新機能ごとに小さなアニメーションのデモが付きます。",
            "ko-KR": "다음 버전부터 새 기능마다 작은 애니메이션 데모가 함께 나와요.",
            "hi-IN": "अगले संस्करण से हर नई सुविधा एक छोटे एनिमेटेड डेमो के साथ आएगी।",
          },
          scene: { kind: "mascot", steps: [{ pose: "wave" }] },
        },
      ],
    },
  },
  {
    version: "0.8.53",
    date: "November 12, 2026",
    added: [
      "A new crochet raccoon mascot sits on the message box in every session, not only in new ones.",
      "The mascot shows what the agent is doing: it thinks, searches with a magnifying glass while reading code, and types on a laptop while editing or running commands.",
      "The mascot reacts to what you write: it celebrates a thank-you, looks sad when something isn't working, and covers its eyes at an apology.",
      "A new session opens with the mascot taking out its laptop and typing once, then settling down.",
      "Replying to selected text now has the microphone of the main message box, to dictate the reply.",
      "Attach images and files to a reply about selected text, with the + button or by pasting a screenshot.",
      "While replying to selected text, elements picked in the browser and its annotated screenshots go into that reply.",
    ],
    improved: [
      "The mascot waves once when the agent needs your answer, falls asleep after a few quiet minutes, and is surprised when a reply ends on an error.",
      "Clicking the browser panel no longer closes a reply to selected text, so you can pick elements for it.",
    ],
  },
  {
    version: "0.8.52",
    date: "November 11, 2026",
    added: [
      "The side chat opens in the side panel from the ⋮ menu, looks and scrolls like the main chat, and uses the same message box.",
      "Minimize the side chat to a card you can drag to any corner of the chat area, clear of the sidebar and the side panel.",
    ],
    improved: [
      "Each session keeps its own side chat: switching sessions hides it and coming back shows it again.",
      "The side chat appears once a session has messages, so there is always something to ask about.",
      "The Changes view opens faster: it shows the last result at once, reads git in parallel, and starts loading when you point at its button.",
      "Moving between files in the Changes view jumps straight to them, without a scrolling animation.",
    ],
    fixed: [
      "Deleted sessions came back after a reload or a save.",
      "Projects stopped copying their old data folder every 10 seconds, which slowed down opening sessions.",
    ],
  },
  {
    version: "0.8.51",
    date: "November 11, 2026",
    improved: [
      "Sessions load at once again: copying what an older Nyxs writes in a project's old data folder no longer holds up reading them.",
      "A deleted session leaves Recents right away.",
      "Opening a session no longer moves it to the top of Recents as just used.",
      "The Git bar and Recents show the same PR when a session has several.",
    ],
    fixed: [
      "A session deleted while it was being saved, or while another one was deleted, came back to Recents.",
      "At startup, projects showed \"No conversations yet\" until their sessions loaded.",
    ],
  },
  {
    version: "0.8.50",
    date: "November 11, 2026",
    added: [
      "Settings › Privacy lists everything that goes through the Nyxs service, with switches for chat titles, image descriptions, semantic search and device details.",
      "Semantic search asks once per project before sending its files to the Nyxs service.",
      "Routines can be edited.",
      "In Manage models you can set the context window of a local or custom model by hand.",
      "Files in UTF-16 or Latin-1 open read-only with their encoding shown, instead of being converted when saved.",
      "With auto save off, leaving a file with unsaved changes asks whether to save, discard or stay.",
      "Links that open a new window on a website open in a new tab of the built-in browser.",
      "A notice tells you when Nyxs left an unreadable data file alone, or when a rewind couldn't restore some files.",
    ],
    improved: [
      "The built-in browser and computer use ask for permission in Ask and Plan modes, like the other actions.",
      "Dangerous shell commands are recognized behind .exe, quotes, paths, sudo and bash -c, and chaining commands no longer slips past an \"ask\" rule.",
      "Project settings that run commands or loosen permissions wait until you trust the project.",
      "Plugins and skills install without shell commands, at the commit their catalog reviewed, and Claude-format plugins load their hooks and MCP servers.",
      "Each turn uses the permissions, hooks and MCP servers of its own project, even while another project is open.",
      "Effort now works on Claude 4.6 and later, Claude 5 and Gemini 3 models.",
      "Language servers install on first use, skip broken binaries and report the edited file's real diagnostics.",
      "Chats save only what changed, keep saving during long replies and no longer pause the window.",
      "On Windows, the processes Nyxs starts close with it, even when the app ends abruptly.",
      "Each project gets a data folder of its own, so two projects never share sessions or history; the old folder is copied, never deleted.",
      "Numbered lists, bold code, bare links and links to project files show correctly in the chat.",
      "Recents, Routines, the browser and plugin errors follow the app's language.",
      "Esc stops a computer-use action at once and lets go of any key or button it was holding.",
    ],
    fixed: [
      "Reopening a session that has its own worktree could delete that folder and its uncommitted work.",
      "Reverting could delete files when an earlier snapshot was missing.",
      "A settings file with a typo was ignored and then overwritten, and an unreadable chat list or session was saved over as empty.",
      "A page in the preview could take over the Nyxs window, and other websites could read files from the previewed folder.",
      "Typing \\, @, # or | with AltGr on Spanish, German or French keyboards triggered shortcuts instead.",
      "A permission card no longer takes the keyboard while you are typing.",
      "Stopping a turn no longer saves its steps twice, and a turn that fails midway shows its error.",
      "Queued messages are sent when their chat finishes, even while you look at another chat.",
      "Replies are no longer forced into Spanish when you write in Portuguese, French or Italian.",
      "Claude Code no longer updates itself while a turn is running.",
      "Diffs of files with accents or ñ in their names show their changes.",
      "The file tools, preview and language servers work in local projects on macOS and Linux, and language servers work in SSH projects.",
      "Editing, retrying or forking a chat with Grok, Cursor, Codex or Antigravity no longer carries on the old conversation.",
      "The chat box keeps your message and attachments when sending fails.",
      "Find in chat also searches older messages.",
      "Clearing the browser's data no longer deletes saved passwords.",
      "Commands on a remote machine no longer hang when they leave something running, and their output isn't cut short.",
    ],
  },
  {
    version: "0.8.49",
    date: "November 10, 2026",
    added: [
      "On Windows, the built-in browser offers to save the passwords you type into websites and fills them in next time.",
    ],
    improved: [
      "Nyxs has a new app identifier; your settings, chats, browser sign-ins and API keys move over by themselves on the first launch. On macOS, Accessibility and Screen Recording need to be allowed one more time, and from now on they stay allowed across updates.",
    ],
    fixed: [
      "Installing an update on Windows no longer fails because the app or one of its processes is still running.",
    ],
  },
  {
    version: "0.8.48",
    date: "November 10, 2026",
    improved: [
      "The Mac app is now signed and notarized by Apple, so it installs and opens without warnings, and Apple Silicon Macs no longer report the download as damaged.",
    ],
  },
  {
    version: "0.8.47",
    date: "November 10, 2026",
    added: [
      "On a remote machine, Claude Code installs or updates itself on the first turn, so you only need to sign in.",
      "Dev servers start on remote Linux and macOS machines, installing Node and missing dependencies when needed.",
      "A session now shows every pull request it opens, including ones opened from another folder or worktree, through GitHub tools, or on the web after the agent pushed the branch.",
    ],
    improved: [
      "A session's pull request keeps its status after its branch or worktree is deleted, and the Git bar shows that pull request instead of offering to create one.",
      "When GitHub can't be read (gh not signed in or no access to the repository), the session shows a gray pull request icon that says why.",
      "A session is archived only once all of its pull requests are merged or closed.",
      "The background tasks panel shows only the open project's tasks, and clearing finished tasks only clears those.",
      "Session titles are written in the language of your first message instead of the app's language.",
      "A session's name in Recents shows a tooltip only when it is cut off.",
    ],
    fixed: [
      "A pull request the agent opened from a temporary worktree now shows in Recents.",
      "The built-in browser's page stays inside its panel while you drag or resize it quickly.",
      "Chat scrolling while a reply is being written is steadier.",
    ],
  },
  {
    version: "0.8.46",
    date: "November 6, 2026",
    added: [
      "The agent can drive the video editor live, the way it drives the browser: it opens projects, edits clips, checks frames and renders while you watch, and every change can be undone.",
      "Claude Code and other CLI agents can now use the video editor too, so they make and change videos in far fewer steps.",
      "The agent can change many clips in one step, review a video on a single sheet of frames, record a web app and make an original music bed.",
    ],
    improved: [
      "Renders encode on an NVIDIA GPU when one is available, or on a Mac's video encoder, using much less CPU and keeping your computer responsive; the render queue shows which was used.",
      "Rendering again after changing only the timeline starts sooner.",
      "The list of video projects updates by itself, and new files in a project's media folder appear in it.",
    ],
    fixed: [
      "Opening a video that is already inside a project opens that project instead of copying the file into a new one.",
      "Opening and closing a project without editing it no longer rewrites its timeline.",
    ],
  },
  {
    version: "0.8.45",
    date: "November 5, 2026",
    added: [
      "A music player in the title bar shows the song, artist, cover and progress, with buttons to skip, pause, change the volume and mute.",
      "Connect YouTube Music in Settings > Music and it plays with your account without opening any page.",
      "The music icon in the title bar searches as you type, on YouTube Music and in your own music folder, without stopping the song playing.",
      "Ask the agent to play a song, pause, skip it or change the volume.",
      "On Windows the player can also show and control what plays in other apps, such as Spotify or your browser.",
      "A visual shown in another panel now works like a canvas: select elements and send them to the chat, draw on it, reload it, try phone, tablet and desktop sizes, copy it as an image or download it.",
      "Settings > General shows the installed version and lets you check for updates.",
    ],
    improved: [
      "The agent respects the tabs you have open in the built-in browser: it reuses the tab of the project it is testing and opens any other site in a tab of its own.",
      "When the agent writes a new visual, it replaces the one open in the panel, so asking for a change shows the result there.",
    ],
    fixed: [
      "What the agent does in the built-in browser in one session no longer shows in or changes another session's browser.",
      "A page opened by an agent now appears in that agent's chat, not in the one you happen to be looking at.",
      "A page can no longer send an element to the chat while the element picker is off.",
    ],
  },
  {
    version: "0.8.44",
    date: "November 5, 2026",
    added: [
      "A new Video view lets you make and edit videos inside Nyxs, with a live player, a multi-track timeline, an inspector and a media bin.",
      "Open a video file you already have, or an existing Remotion project, and edit it: trim, split, change speed, detach the audio, freeze a frame or remove silences.",
      "Render to MP4, WebM, ProRes or GIF from a queue that shows progress and keeps running when you close the dialog.",
      "Ask the agent for a video or a change to one: it creates the project, looks at the frames it made, adds captions, cuts silences or filler words, and renders the result.",
      "Rename, duplicate or delete video projects from their menu; deleting moves the folder to the recycle bin.",
      "Red is a new color for highlighting text in the chat.",
    ],
    improved: [
      "The list of an agent's steps now shows connecting lines that branch into each step.",
      "Highlight colors in the chat are brighter and easier to see.",
    ],
    fixed: [
      "The glowing frame shown during computer use no longer slows down the whole PC.",
    ],
  },
  {
    version: "0.8.43",
    date: "November 4, 2026",
    added: [
      "Computer use on macOS 14 or later: the agent can see your screen, use the mouse and the keyboard, and read windows' buttons and fields by name, with the same glowing frame and Esc to stop.",
      "On a Mac, Settings shows whether Nyxs has the Accessibility and Screen Recording permissions computer use needs, with a button that opens the right pane of System Settings.",
      "A new session shows a field of drifting letters behind the empty screen that brightens under the pointer and ripples where you click.",
    ],
    improved: [
      "Prompt suggestions propose the next concrete step or an answer to the agent's question, and never a question of their own.",
    ],
  },
  {
    version: "0.8.42",
    date: "November 3, 2026",
    improved: [
      "When the model picker has more providers than fit, arrows and faded edges show there are more, and the mouse wheel scrolls through them.",
      "The permission mode button looks the same in every mode, including Skip permissions, so it's easier to read.",
    ],
    fixed: [
      "Tooltips and menus show in front of the browser page instead of behind it, without freezing a playing video.",
      "A dialog that grows after opening, like deleting a session with uncommitted files, is no longer partly hidden behind the browser page.",
    ],
  },
  {
    version: "0.8.41",
    date: "November 2, 2026",
    added: [
      "Computer use on Windows: turn it on in Settings and the agent can see your screen and use the mouse, the keyboard and your open windows to work in desktop apps.",
      "The agent reads a window's buttons and fields by name and acts on them directly, which hits far more reliably than clicking at coordinates.",
      "While the agent uses your computer, a glowing frame with a notice surrounds the screen, and pressing Esc stops it from anywhere.",
      "Claude Code, Codex and the other CLI agents get computer use too, with the same frame, Esc and permissions.",
    ],
    improved: [
      "A command's output in the chat sits unboxed under its row like a code block, with a copy button, and long lines wrap.",
      "A command that ends with a non-zero code no longer shows a warning sign, since many do without anything going wrong.",
    ],
    fixed: [
      "Clicking into the browser's address bar shows the full address right away.",
    ],
  },
  {
    version: "0.8.40",
    date: "November 1, 2026",
    added: [
      "A reply from an API model that the app cut off by closing, crashing or restarting carries on by itself when the app comes back within a few minutes, or shows a Continue button.",
    ],
    improved: [
      "Animations stay smooth with several sessions working at once: sessions you aren't looking at update their text less often.",
      "Write keeps each unchanged line's own line ending in files that mix Windows and Unix line endings.",
    ],
    fixed: [
      "On Windows, two edits to the same file at the same moment could undo one another, or an edit could be refused as outside the project.",
      "Typing in the browser's address bar right after opening a page could glue the new text onto the old address.",
    ],
  },
  {
    version: "0.8.39",
    date: "November 1, 2026",
    added: [
      "The context panel shows how the window splits up for every provider, not just Claude Code, with an estimate built from the prompt, tools, memory, skills and conversation Nyxs sends.",
      "The context panel breaks each category into its items, like each MCP server, memory file or skill, marks deferred tools, and explains every row.",
      "An Anthropic API key scoped to an organization can name the workspace it works in, in Settings › Providers.",
    ],
    fixed: [
      "Anthropic API keys from organizations that limit browser access failed to load models or answer.",
      "When several messages from other sessions arrived while a session was busy, it could run two turns at once; now they all go into its next turn together.",
      "Reading a provider's models no longer stays on \"Loading…\" after switching providers midway, and a failed read is retried next time.",
    ],
  },
  {
    version: "0.8.38",
    date: "October 31, 2026",
    added: [
      "The browser's address bar suggests searches from your search engine as you type, like Chrome, and a custom search engine can have its own suggestions address in Settings.",
      "On Windows, the agent can read and use the inside of embedded frames on websites, like videos, payment forms and ads.",
      "Subagents started by Codex, Grok and Antigravity show up in Background tasks with their activity.",
      "A setting to stop read-only commands from being approved automatically in \"Accept edits\" mode.",
    ],
    improved: [
      "Edit diffs in the chat highlight the words that changed and fold long stretches of unchanged lines.",
      "When a turn runs out of output tokens, the chat says so, and if the model was only thinking it retries once.",
      "/compact can be stopped with Esc or the stop button, and automatic compaction leaves a divider in the conversation too.",
      "Rewind leaves alone files that another session or you changed, and lists them, instead of undoing that work.",
      "Console programs the agent starts on Windows no longer flash a window.",
      "Files on remote Windows and macOS machines update right away instead of every two seconds.",
      "The custom provider shows its own icon and translated name in the model menu and in Manage models, and Antigravity CLI has its own icon.",
      "The \"missing API key\" notice is fully translated.",
    ],
    fixed: [
      "Two edits the agent made to the same file at the same time could undo each other.",
      "Edits to files with Windows line endings could leave a stray line break that made Git treat the file as binary.",
      "Commands like `ffprobe -show_entries format=duration` or `git log --format=…` were blocked as if they formatted a disk.",
    ],
  },
  {
    version: "0.8.37",
    date: "October 30, 2026",
    added: [
      "The agent can watch videos: models that take video, like Gemini, Qwen or MiniMax, get the whole clip, and every other model that sees images gets frames with their timestamps. Attach a video or point it at one in your project.",
    ],
    improved: [
      "Images a tool returns, like a screenshot or an image the agent reads, now reach Qwen, MiniMax and other OpenAI-compatible models as images instead of text.",
      "When a model's server limits how many images fit in one request, the agent keeps the newest ones instead of failing.",
      "MiniMax's thinking shows as reasoning instead of appearing as text in the answer.",
      "The jump-to-end button shows a dot wave while the agent works, and an opened reasoning block keeps to an eight-line window.",
      "PR changes show up within seconds in the Git bar and in Recents.",
    ],
    fixed: [
      "Some provider errors showed as \"[object Object]\" instead of the provider's message.",
      "An address typed in the browser while the previous page was still loading could be overwritten.",
    ],
  },
  {
    version: "0.8.36",
    date: "October 30, 2026",
    added: [
      "A merged PR shows a purple card above the Git bar, whether it was merged here, on GitHub or by the agent; several merged PRs stack up into one card you can expand.",
      "Files show the same icons as in VS Code, in the Files panel and in diffs.",
      "Each permission mode has an icon, and the mode button turns red while permissions are skipped.",
    ],
    improved: [
      "Code in the chat looks like Claude Code's: no box, a copy icon right next to it, and long lines wrap instead of scrolling.",
      "Emails and messages the agent drafts for you come in their own block with a copy button.",
      "The Git bar finds your PR and its CI wherever it was opened: from GitHub's site, a terminal, a teammate, a fork, another worktree, or a branch pushed under another name. A new PR's checks show up within seconds.",
    ],
  },
  {
    version: "0.8.35",
    date: "October 30, 2026",
    improved: [
      "A session shows its green PR icon in Recents, and the PR in the Git bar, seconds after the agent opens it, including PRs opened from a worktree or in the middle of a long turn.",
      "Dialogs and menus over a website in the browser cast their shadow on the page, so they look like the rest of the app.",
    ],
    fixed: [
      "Deleting an archived or nested session from Recents did nothing.",
      "Long links in messages overflowed the chat instead of wrapping.",
      "Reading a web page or searching the web could leave a turn stuck on \"Working…\": every web read now has a time limit and stops when you interrupt the turn.",
    ],
  },
  {
    version: "0.8.34",
    date: "October 29, 2026",
    improved: [
      "The update card is redesigned: flip through what's new one item at a time, and the install button shows the download progress.",
      "/compact draws a divider in the conversation while it runs, and leaves one behind showing how much context it freed.",
    ],
    fixed: [
      "On short screens the update card hid its install buttons.",
    ],
  },
  {
    version: "0.8.33",
    date: "October 29, 2026",
    added: [
      "Choose the browser's search engine (Google, DuckDuckGo, Bing, Brave or your own) and get suggestions from the pages you visited and your project's servers as you type.",
      "The changes panel can show uncommitted changes or all of the branch's changes, and its count matches the Git bar.",
      "Remote machines: sign in with a password or key passphrase, and use per-session worktrees and Revert on projects over SSH.",
      "GPT models edit files with apply_patch, the format they handle best.",
      "Grok and Claude Code show a countdown when they wait for a usage limit before retrying.",
    ],
    improved: [
      "The agent's clicks and key presses on websites are real input on Windows, so fullscreen, clipboard and new windows work, and it can click inside embedded frames.",
      "Browser screenshots capture the page itself, even with another window on top.",
      "App shortcuts work while the focus is inside a page in the browser.",
      "Each local page in the browser keeps its own storage and cookies, and follows the Keep cookies setting.",
      "Annotation drawings stay on the page when you scroll, and the agent waits for short page timers after an action.",
      "Long tasks keep going: sub-agents trim their context, and a very long turn summarizes its start instead of failing.",
      "Revert also undoes what a background build or test changed after the turn ended.",
      "The first snapshot of a large folder is about twice as fast and skips big untracked files.",
      "Antigravity can use the built-in browser in every permission mode, keeps your own permission rules, and two Nyxs windows no longer mix up their tools.",
      "Remote projects on Linux see file changes instantly, can open their HTML files in the browser, and links can't lead outside the project.",
      "Stopped tools show a neutral stop icon instead of a red error.",
    ],
    fixed: [
      "The \"Compacting\" notice showed in every session instead of only the one being compacted.",
      "A queued message could land in another chat if you switched sessions as it was sent.",
      "The browser's back and forward buttons and address bar now follow navigation inside a website.",
      "Each browser tab with a local page talks to its own server, even in the background.",
      "Settings pages use the full width, like Providers.",
      "The PowerShell host no longer uses a local network socket, which antivirus software could flag.",
      "Commands started by the agent can no longer launch child processes that escape cleanup when Nyxs closes.",
    ],
  },
  {
    version: "0.8.32",
    date: "October 29, 2026",
    added: [
      "Split view: open two sessions side by side from a session's menu (\"Open to the side\") or by dragging it onto the chat, each with its own conversation and message box.",
      "A warning above the message box when a Claude Code plan limit passes 75% and 90%, and a red notice with the reset time when the plan is out of room.",
      "A \"Push\" button in the Git bar when a pull request is open and there are commits not yet pushed, with \"Pull and push\" if the remote moved.",
      "Reading a YouTube link brings back what is said in the video, with timestamps, not just its title and description.",
      "Grok and Antigravity can ask you questions with options and send their plan for review, and get the visual preview guide and NYXS.md like Claude Code.",
      "In \"Ask\" mode, an agent repeating the same call three times asks you whether to continue instead of looping.",
    ],
    improved: [
      "Claude Code's next-prompt suggestion no longer starts a background process after every reply.",
      "Commits, branch changes and pulls made outside Nyxs show in the Git bar within a second.",
      "Forms, logins and API calls work in the built-in browser's preview of your local app, and the address bar and back/forward follow clicks inside a website.",
      "While a dev server starts, its latest output line shows live, with a button to cancel it.",
      "The rewind dialog counts and lists the files a command changed, not only the ones the agent edited.",
      "Settings pages use the full width of the window, and the Providers list can be browsed with the arrow keys.",
      "Corners across the app are a bit tighter and consistent.",
      "Long prompts reach Antigravity whole instead of being cut at 24,000 characters.",
    ],
    fixed: [
      "Closing Nyxs could leave its process running in the background with no window.",
      "After editing, retrying or forking a message, Claude Code continued from the old conversation instead of the one on screen.",
      "Clicking outside a dialog opened over a website now closes it instead of clicking the page.",
      "Settings › Account could crash on an unexpected answer from the server.",
      "A single page read was summarized as \"Searched once\".",
    ],
  },
  {
    version: "0.8.31",
    date: "October 28, 2026",
    improved: [
      "Nyxs runs on Tauri 2.12 with up-to-date plugins, including a newer auto-updater, notifications and file dialogs.",
      "React, Vite and the AI SDK are updated to their latest compatible versions, with their fixes.",
    ],
  },
  {
    version: "0.8.30",
    date: "October 28, 2026",
    added: [
      "Agents can create new sessions, as in Claude Code Desktop: ask for one and it opens nested under the current session in Recents, on the same model and effort unless you name others (\"with Haiku 5.5, low effort\"), and its first reply comes back to the session that created it.",
      "Claude Code, Codex and other coding agents can list, read, message, create, rename and archive your sessions too.",
      "A session an agent created shows as a card in the chat, with its state and a click to open it, and messages from another session show as \"Message received from…\".",
    ],
    improved: [
      "Recents nests created sessions under their parent with a fold arrow, and deleting a parent asks whether to delete its nested sessions too or move them up a level.",
      "A session created with its own effort keeps it: the picker shows it and changing it there changes only that session.",
      "Models know that a \"session\" means a Nyxs conversation, even typed \"secion\", instead of searching the project's code for it.",
      "The app stays smooth while a long build runs in the background.",
    ],
    fixed: [
      "The window could stop responding when a program running in a terminal ended or restarted itself, for example when an app updated.",
      "Switching projects, removing a worktree, making a PDF or connecting to a remote machine no longer freezes the window while they work.",
      "Attaching a very large file no longer crashes the app: files over 50 MB are not read, and the agent is told why.",
      "Sessions are saved even when Windows briefly locks their file, instead of failing with \"Access denied\".",
      "Messages sent to a session that is busy are delivered when its turn ends, instead of being lost.",
    ],
  },
  {
    version: "0.8.29",
    date: "October 28, 2026",
    added: [
      "Remote machines: a project can live on another computer over SSH (a VPS, the PC at home), and Nyxs reads, edits, searches, runs commands and opens its dev servers there, with the same sessions on every PC.",
      "Keyboard shortcuts to switch sessions (Ctrl+Tab), change the permission mode, model and effort, and pick menu items with 1–9.",
      "File paths in the chat are clickable, with a menu to open, reveal or copy them.",
      "A side chat (/btw or Ctrl+J) for quick questions that don't interrupt the session.",
      "Comments on diff lines, sent together with Ctrl+Enter, and a review card with \"Fix this\" and \"Walk in diff\".",
      "Auto-merge and auto-fix for each pull request.",
      "Sessions in their own worktree, copying the files listed in .worktreeinclude.",
      "An editor in the Files panel that saves as you type.",
      "Saved environments with variables for each session.",
      "Import a Claude Code CLI session with /resume.",
      "Export the app's logs to a zip for support.",
      "Agents can list, read, message, rename and archive your other sessions.",
    ],
    improved: [
      "Notifications name the session and open it when clicked.",
      "The permission mode is remembered for each project folder.",
      "Ctrl+O switches the transcript between normal, reasoning and detailed views.",
      "launch.json supports env, autoPort and ${workspaceFolder}.",
      "Help lists each command once, with shorter descriptions.",
      "Tooltips stay inside the window.",
    ],
    fixed: [
      "The built-in browser belongs to each session alone: a model using the browser in one session no longer shows its pages (your mail, say) in another session or project.",
      "Deleting or archiving a session with uncommitted changes names those files before you confirm.",
      "Windows shows the current Nyxs logo in notifications instead of an old cached one.",
    ],
  },
  {
    version: "0.8.28",
    date: "October 27, 2026",
    improved: [
      "Websites in the built-in browser follow the app's light or dark theme, switching live as you change it and opening in the right one from the start.",
      "Each chat keeps its own browser page alive when you switch between sessions.",
      "The browser only offers the current project's dev servers.",
    ],
    fixed: [
      "A session that merges or reviews someone else's pull request shows that PR's icon in Recents again.",
      "Commands that only mention \"git push\", such as a search, no longer link a session to a branch.",
      "The title bar's menu shows whole over a page open in the browser.",
    ],
  },
  {
    version: "0.8.27",
    date: "October 26, 2026",
    improved: [
      "Picking an element in the built-in browser gives the page its clicks back; the arrow button or Ctrl+Shift+S picks the next one.",
    ],
    fixed: [
      "Pressing Tab on a suggested message types the whole message, not the shortened preview ending in \"…\".",
      "Two elements of a page that look alike, such as two fields of a dialog box, can both be added to the same message.",
    ],
  },
  {
    version: "0.8.26",
    date: "October 26, 2026",
    added: [
      "Several accounts per agent: Claude Code, Codex CLI and Grok CLI keep every account you sign in to, and you switch between them from Settings › Providers. Add account signs in without touching the one in use.",
      "Devin and OpenCode join the coding agents you can connect and chat with on your own account.",
      "Coding agents install in the background with one click, with no terminal window, and you can cancel an install.",
      "Each agent's account shows its email, its plan and how much of its limits you've used, with Grok's and Antigravity's limits too.",
      "The built-in browser has favorites: a star in the address bar saves the page, and a bar under it opens the ones you saved.",
      "A local server that Nyxs didn't start (from a terminal or another app) can be stopped from the browser's list of servers.",
      "Tables in the chat are drawn as a table, a side-by-side comparison or a list, whichever reads best for what they hold.",
    ],
    improved: [
      "Settings › Providers lists the coding agents first, each with its version and a switch that connects it.",
      "Providers open instantly with what Nyxs last knew about them and update quietly, without loading spinners every time.",
      "The Settings window is larger, and the provider list wider.",
      "A page open in the built-in browser darkens under a dialog like the rest of the app, title bar included.",
      "The window's close button reaches the corner, without the thin border around the window (Windows).",
    ],
    fixed: [
      "An agent CLI installed or signed in from a terminal while Nyxs was open is recognized without restarting Nyxs.",
    ],
  },
  {
    version: "0.8.25",
    date: "October 25, 2026",
    improved: [
      "Settings › Providers lists every provider on the left with a search box, and shows the one you pick on the right with its account, its models and the button to connect or disconnect it.",
      "A provider's models are switched on and off with the same switches as in Manage models, show by name only, and refresh on their own, so there is no reload button anymore.",
      "Going back to a provider in Settings shows its status right away instead of checking its CLI, and Claude Code's latest version, every time.",
      "Error messages from Nyxs itself, such as a CLI that isn't installed, a file that can't be opened or a server that doesn't answer, appear in your language.",
      "Every dialog works the same way: Escape closes only the top one, the keyboard stays inside it, and it shows correctly over a page open in the built-in browser.",
      "Reverting a whole session asks and reports in a Nyxs dialog, in your language, instead of a system pop-up.",
      "Links you open from the chat go straight to the built-in browser, without a list of allowed sites to manage.",
    ],
  },
  {
    version: "0.8.24",
    date: "October 25, 2026",
    added: [
      "The background tasks panel shows what each sub-agent is writing and which tools it is using, live, and you can stop one or all of them without stopping the conversation.",
    ],
    improved: [
      "Manage models has a tab per provider, like the model picker, and refreshes every provider's models on its own when it opens.",
      "A video in the built-in browser keeps playing around Settings instead of freezing while Settings is open (Windows).",
      "The folder menu and the confirmation dialogs are more compact, with tighter corners.",
      "Antigravity opens pages in Nyxs' built-in browser instead of your system browser, and offers only the reasoning levels each of its models accepts.",
    ],
    fixed: [
      "A terminal window no longer flashes up when Nyxs opens or you switch provider: Antigravity CLI's updater now runs hidden (Windows).",
      "Antigravity keeps the built-in browser when an installed Nyxs and a development build are open at the same time.",
      "Typing in the model picker's search works right after using the built-in browser.",
    ],
  },
  {
    version: "0.8.23",
    date: "October 24, 2026",
    added: [
      "Connect Grok CLI, Antigravity CLI, Cursor CLI and Codex CLI in Settings › Providers and chat with them on your own account, just like Claude Code.",
      "Connect DeepSeek Harness, DeepSeek's own coding agent, with your DeepSeek API key.",
      "Nyxs finds these CLIs when they're already installed, and installs one or opens its sign-in from Settings when it isn't.",
      "These agents can use the built-in browser, ask before running commands or changing files under your permission rules, and ask you questions with options.",
      "The context meter shows the plan limits Antigravity and Codex report.",
      "Browser tabs show each page's icon as soon as it starts loading.",
      "Rewinding to a message asks what to restore: the code, the conversation or both, and shows how many files would change.",
    ],
    improved: [
      "The model picker groups models by provider, and its search stays within the provider you're on.",
      "Reasoning effort is chosen right under the model in the picker, with only the levels that model offers.",
      "Model names that come with a lab prefix, such as minimaxai/minimax-m3.1-flash, show without it.",
      "The built-in browser is on by default.",
      "Commands that use npm, npx or pnpm run even when Windows blocks PowerShell scripts.",
    ],
    fixed: [
      "Codex CLI installs from Settings even when Windows blocks PowerShell scripts.",
    ],
  },
  {
    version: "0.8.22",
    date: "October 23, 2026",
    added: [
      "The agent can find things on a page by their text, fill a whole form in one go, chain several browser steps in one call, click a point of a screenshot (a canvas, a map) and zoom into part of it.",
    ],
    improved: [
      "The agent works the built-in browser in fewer steps: every click or keystroke tells it what changed on the page, and opening a page comes back with what it shows.",
      "The agent's references to page elements keep working while the page redraws them, and its page reads stay short by showing what is on screen.",
      "Before clicking, the agent checks that nothing covers the element, such as a cookie banner, and says what is in the way.",
      "The agent drives websites in the built-in browser faster.",
      "Sub-agents that run in parallel merge their work back one at a time, without conflict markers, and a run that can't be merged keeps its changes aside.",
      "Sub-agents start even when the project has git hooks, such as husky or lint-staged.",
      "Web search works with every provider, free and without a key.",
      "Asking about a link or a YouTube video reads that page directly instead of searching for its address.",
      "Settings is simpler: Hooks is gone, and Billing and Usage are hidden for now.",
    ],
    fixed: [
      "The views panel keeps its width after you minimize and restore the window.",
      "The browser page goes back to its place when you leave the maximized panel, instead of staying over the chat.",
    ],
  },
  {
    version: "0.8.21",
    date: "October 23, 2026",
    added: [
      "Theme presets in Settings › General, under Appearance: Default, Catppuccin, Gruvbox Material, One Light and Solarized for light mode; Default, Catppuccin, Dracula, Gruvbox Material, Monokai, One Dark Pro, Tokyo Night, Solarized and Vesper for dark mode.",
      "Tune any theme's background, text and accent colors with a color picker or a hex code; the whole app follows, and each mode keeps its own choice.",
    ],
    improved: [
      "A session at work in the sidebar shows a terminal-style dot spinner, and its title shimmers.",
      "The minimap and the jump-to-end button take you there at once instead of scrolling through the chat.",
      "The chat text keeps a little room from the minimap when the window is narrow.",
    ],
  },
  {
    version: "0.8.20",
    date: "October 23, 2026",
    added: [
      "Highlight text in the chat: select it and pick a color next to Reply. Highlights stay with the chat, and selecting highlighted text again lets you remove it.",
      "A minimap of your messages along the right edge of the chat: hover a tick to preview the message, click it to jump there. A turn with something highlighted shows its tick in that color.",
      "Shell commands in a reply get Run and Copy buttons: Run starts the command in a shell of its own and shows its output right under it, and \"Open in terminal\" moves that shell into the Terminal panel.",
    ],
    improved: [
      "The status line under a working reply has its own animation for subagents, web searches, shell commands, background work, compacting and retries.",
      "The status line shows when Claude Code is compacting its session or waiting to retry a request, including while it waits out the usage limit.",
      "Command blocks in the chat are colored like a terminal, with the program in each command standing out from its arguments, and command output keeps its colors.",
      "The status line's clock counts tenths of a second.",
    ],
  },
  {
    version: "0.8.19",
    date: "October 23, 2026",
    added: [
      "A round button above the message box jumps back to the end of the chat; it shows once you scroll up a bit.",
      "Pick several elements in the browser for the same message: the picker stays on after each click and every element gets its own chip.",
    ],
    improved: [
      "A reply that edited files ends with a card listing each file, its folder and its own +/- count, plus \"View all\" with the totals; click a file to open the changes panel right at it.",
      "Each session keeps its own unsent message: switching sessions no longer carries what you were typing into the other one, and it is still there when you come back.",
      "The sessions list notices sooner when a pull request is merged or closed, and checks again as soon as you come back to the app.",
    ],
    fixed: [
      "Line counts in the chat match the changes panel: unchanged lines the model quotes around an edit no longer count as added and removed, and the files card no longer adds up earlier turns.",
    ],
  },
  {
    version: "0.8.18",
    date: "October 23, 2026",
    added: [
      "A visual in the chat has a ⋯ menu to copy it as an image or download it as HTML, and a button to show it in a side panel.",
      "Buttons inside a visual can send a message to the chat for you, like \"Apply this one\".",
    ],
    improved: [
      "Visuals in the chat look like part of the app: they use its colors, font and dark mode, and come as one visual with every option labeled and the explanations in the reply.",
      "The git bar finds your pull request even when the repo belongs to another of your GitHub CLI accounts, without switching accounts.",
      "The git bar notices on its own when a pull request's checks run again or the pull request is merged or closed.",
      "Tighter corners on the git bar, the side panel views, the terminal's buttons and the chat visuals.",
      "Tool chips in the chat no longer show a tooltip with the file path or command.",
    ],
    fixed: [
      "The git bar goes away once everything is pushed: files that were only touched or had their line endings converted no longer count as changes, and they don't inflate the +/- count.",
    ],
  },
  {
    version: "0.8.17",
    date: "October 22, 2026",
    added: [
      "A bar above the message box shows the project, the branch and how many lines it adds and removes; click the numbers to open the changes panel.",
      "A \"Create PR\" button in that bar commits what's pending, pushes the branch and opens the pull request.",
      "With a pull request open, the bar shows base → branch, a CI chip with the checks in progress, passed, failed and skipped, and a \"View PR\" button.",
      "Several side views can be open at once: two stack, a third opens a second column and a fourth makes a 2×2 grid, with draggable dividers and a maximize button on each view.",
      "Ask to see how something would look, or for design ideas, and the agent draws live mockups right in the chat, with a Preview / Code switch. Claude Code models do it too.",
    ],
    improved: [
      "The pull request command is now /create-pr.",
      "Slash commands show in the link color, both in the message box while you type and in the chat.",
    ],
  },
  {
    version: "0.8.16",
    date: "October 22, 2026",
    improved: [
      "Menus are more compact, with tighter corners: permission mode, effort, model picker, context and usage, the changes panel's options, the browser's servers and options, and the title bar's ⋮ menu.",
      "Claude Code's plan limits show up right away: they are fetched as soon as a Claude Code model is in use, and the last reading is kept across restarts.",
      "Nyxs 2.0 is no longer offered in the model picker.",
    ],
    fixed: [
      "Models from other providers can now open the Claude Code memories listed in their prompt, not just see the index. The memory folder is readable but never writable.",
      "The context panel shows a Claude Code model's real window (1M where it applies) instead of 200k, also after the chat's process exits or the app reloads.",
      "The detailed context breakdown appears for every Claude Code chat: when its process has exited, the session is measured read-only, without sending or saving anything.",
      "Estimated cost shows for Claude Code chats, priced at the API rates of the model behind the alias.",
    ],
  },
  {
    version: "0.8.15",
    date: "October 22, 2026",
    added: [
      "Models from other providers now follow the memories Claude Code saves for the project: they get the memory index and open each memory when it matters.",
    ],
    fixed: [
      "Models with native vision get your images again instead of a text description: Nyxs now checks each model's real capabilities (from models.dev) instead of guessing from its name, so models like DeepSeek V4.1 Flash, Kimi K2.5, Gemma 3, Mistral Medium and Qwen 3.5 Plus see attachments, screenshots and images they read.",
    ],
  },
  {
    version: "0.8.14",
    date: "October 22, 2026",
    improved: [
      "A session's status is back at the start of its row: the grey dot when idle, the wave while working, the orange dot when it needs you, or its pull request icon.",
    ],
    fixed: [
      "The sidebar's divider line no longer crosses the update card or the sidebar's menus.",
    ],
  },
  {
    version: "0.8.13",
    date: "October 22, 2026",
    improved: [
      "The sidebar sits flush against the window edge, with a single divider line that runs the full height of the window.",
      "Search is now a search box at the top of the sidebar.",
      "Sidebar rows share the same height and left edge, and a session's status (working, waiting for you, pull request) shows on the right, next to its time.",
      "Less space between Recents and the project folders.",
      "Sidebar menus are solid white with tighter corners, and the Organize recents menu opens outward like the folder and session menus.",
      "The element picker in the browser highlights in blue instead of orange.",
      "The Chat / Code switch is gone from the title bar: Nyxs is all Code for now.",
      "Dispatch no longer has a Beta label, and hovering a project folder no longer shows its path.",
    ],
  },
  {
    version: "0.8.12",
    date: "October 22, 2026",
    added: [
      "Annotate pages in the browser: with the element picker on, a toolbar lets you draw with a pencil, shapes (line, arrow, rectangle, ellipse, numbered steps) and text, then add the screenshot to the chat.",
      "A picked element shows a card when you hover it: a screenshot of its area, its tag and text, and on demand its selector, computed styles, HTML and siblings. All of it goes to the model too.",
      "Prompt suggestions: after each reply the message box suggests what you might send next; press Tab to use it (Settings → General).",
      "Ctrl+Shift+S turns the element picker on and off.",
    ],
    improved: [
      "Settings opens as a dialog over the app, with a search box and an icon for each section.",
      "The browser's server list shows which servers are running: click one to open it, or stop it with its red button. A new tab also spots servers started from a terminal.",
      "Starting a dev server from the browser is much faster, and when it fails you see why, with its last lines of output.",
      "Agents moved to the ⋮ menu of the title bar, and the panel button above the chat is gone.",
      "Open panels are highlighted in blue in the title bar.",
      "What's new only shows on sessions without messages.",
      "The address bar is left-aligned, and the element picker has a new cursor icon and a tooltip that explains it.",
      "The Fork button explains what it does.",
    ],
    fixed: [
      "Starting a server from the browser no longer gets stuck when its port is taken or it crashes.",
      "Reloading the app no longer shows an open website on top of the splash screen.",
      "Settings no longer shows up behind an open website for a moment.",
    ],
  },
  {
    version: "0.8.11",
    date: "October 21, 2026",
    added: [
      "Tool access mode (Settings → Nyxs Code): load connector tools only when needed, or have them all loaded from the start.",
      "A Proactive output style: the agent works autonomously and asks fewer questions.",
    ],
    improved: [
      "The Maximize button of the preview, changes and background tasks panels hides the chat so the panel takes the whole width; the same button brings the chat back.",
      "The preview panel can be dragged wider: the chat now narrows down to 380 px.",
      "Output style is a dropdown at the top of Settings → Nyxs Code, and like tool access mode it applies to new sessions, so a session in progress keeps its prompt cache.",
    ],
    fixed: [
      "/compact really compacts Claude Code sessions now, using Claude Code's own /compact.",
      "The context ring updates as soon as /compact finishes, and goes down after an automatic compaction in the middle of a reply.",
      "/compact says when it fails instead of failing silently, and no longer re-summarizes only the previous summary in short conversations.",
      "On macOS, the arrow keys, Home, End and Delete no longer type strange characters into text fields, such as when renaming a session.",
      "Option+Left/Right moves the cursor by word inside text fields again, instead of going back and forward in the app.",
    ],
  },
  {
    version: "0.8.10",
    date: "October 21, 2026",
    added: [
      "The sidebar can be resized: drag its right edge, double-click it for the default width.",
    ],
    improved: [
      "Each project keeps its own terminals: switching to a session in another project no longer stops a dev server running in the terminal.",
      "Queued messages show their images and file names instead of a bare attachment count.",
    ],
    fixed: [
      "A Claude Code session could stay \"working\" forever after a queued message that was only an image; it now carries on, and never waits more than 20 seconds for a message Claude Code doesn't take.",
      "The quick prompt window no longer opens by itself after an update.",
      "Sessions no longer show a merged or open pull request they never pushed, and are no longer archived because of one.",
      "Session titles are generated again.",
    ],
  },
  {
    version: "0.8.9",
    date: "October 21, 2026",
    added: [
      "Recents are grouped by project folder: you see at a glance where you're working, folders can be collapsed, and each one has a + to start a session right there.",
    ],
    improved: [
      "New versions show up while the app is open: Nyxs checks every half hour and when you come back to the window, instead of only at start-up.",
      "After an update, Nyxs reopens on the monitor it was on, with the same size and position.",
    ],
    fixed: [
      "Nyxs could freeze while a Claude Code session was busy: messages to Claude Code and keystrokes to the terminal no longer wait for the other side to read them.",
      "Closing a terminal or stopping a reply no longer holds the window while their processes are being ended.",
    ],
  },
  {
    version: "0.8.8",
    date: "October 21, 2026",
    added: [
      "Reloading the app no longer stops your work: terminals and the servers in them keep running, the browser keeps its pages as they were, Claude Code sessions carry on and their reply is rebuilt, and sessions with other models pick the task up again on their own.",
      "Several terminals as tabs: Ctrl+Shift+` opens a new one, and closing a terminal that still runs something asks first.",
      "Nyxs keeps the Claude Code CLI up to date by itself.",
    ],
    improved: [
      "Workflows now show in Background tasks, together with the other running work.",
      "The browser's Servers and settings menus open at once, without the page blinking.",
      "Comments are now allowed in the codebase's style guide.",
    ],
    fixed: [
      "The Claude Code login no longer expires every day: Nyxs renews it from a single process and never stops one halfway through a renewal.",
      "Opening a session in Recents no longer moves it to the top; only new activity does.",
      "Command output in Background tasks and in the chat no longer shows raw color codes.",
      "Closing a terminal now also stops the programs started from it, instead of leaving them holding their port.",
    ],
  },
  {
    version: "0.8.7",
    date: "October 20, 2026",
    added: [
      "Documents you attach now reach the model: text files are read in full, and PDFs and other files are saved so the agent can open them. The document card stays on your message across sessions and restarts.",
    ],
    improved: [
      "On Windows, Nyxs is now signed by a verified publisher.",
      "Sub-agents can take up to 40 steps for bigger tasks (configurable with generation.subagentMaxSteps), and always hand back a final report.",
    ],
    fixed: [
      "Windows Defender no longer flags Nyxs as a threat because of how it started its PowerShell host and launched detached programs.",
      "A parallel Workflow now runs every item instead of silently dropping those past the agent limit, and no longer hangs when there are more items than agents.",
      "After attaching a file you can type right away, without clicking the message box first.",
    ],
  },
  {
    version: "0.8.6",
    date: "October 20, 2026",
    fixed: [
      "On Mac, Nyxs no longer asks for your Keychain password over and over at startup: all its secrets now live in a single Keychain item, so it asks at most once per launch. Choose \"Always Allow\" to stop the prompt until the next update.",
    ],
  },
  {
    version: "0.8.5",
    date: "October 20, 2026",
    added: [
      "Messages you send while the agent is working now show in the chat as queued bubbles, and reach the model at the next natural pause instead of waiting for the whole reply. \"Send now\" gets it read as soon as possible.",
      "Your messages show a read receipt once the model has read them.",
      "Each session in the recents list shows its pull request status with a coloured icon: open, draft, merged or closed.",
    ],
    improved: [
      "The composer no longer shows extra queue and interrupt buttons while the agent works: press Enter to queue a message, Ctrl+Enter to interrupt and send.",
    ],
    fixed: [
      "The feedback dialog no longer closes, losing what you typed, when you click outside it.",
    ],
  },
  {
    version: "0.8.4",
    date: "October 20, 2026",
    added: [
      "Nyxs's own agent now wakes up when a command it left running in the background finishes, even if you are in another chat, and carries on with what it planned.",
      "The Background tasks panel has a new look: compact rows showing how long each task ran, collapsible groups, and the command and its output one click away.",
    ],
    improved: [
      "A finished background task now shows up inside the reply's activity summary, and its title opens that task in the panel.",
      "Finished tasks are folded by default, and each session remembers whether you unfolded them.",
    ],
  },
  {
    version: "0.8.3",
    date: "October 19, 2026",
    added: [
      "Claude Code's background tasks (commands left running, monitors) now show up in the Background tasks panel, with their status and output.",
    ],
    fixed: [
      "When a background task finishes, Claude Code's follow-up now appears in its chat and can keep working, instead of being blocked as if nobody were there.",
      "If no chat can show that follow-up, its actions follow the session's permission mode rather than being denied.",
      "Claude Code stays running while it has background tasks in progress, so it hears back when they finish even if the session sits idle for hours.",
    ],
  },
  {
    version: "0.8.2",
    date: "October 19, 2026",
    added: [
      "Meet the Nyxs raccoon: it waits on the message box of every new session, pulls out its laptop to type for a moment, and steps aside once you send your first message.",
      "A new app icon and logo.",
    ],
    improved: [
      "The recent sessions list is more compact, so more of your sessions fit at a glance.",
    ],
    fixed: [
      "Undoing a turn now reverts every command the agent ran, even when it ran several at the same time.",
      "Undoing a turn no longer reverts what you or another agent changed while a command was running in the background.",
    ],
  },
  {
    version: "0.8.1",
    date: "October 19, 2026",
    improved: [
      "The page in the built-in browser stays visible while you resize the panel, and shows a still image while a menu or the server list is open, instead of going blank.",
      "Long sessions are steadier: when the agent summarizes earlier work in the middle of a turn, it no longer treats summarized files as still in view.",
    ],
    fixed: [
      "Undoing a turn no longer reverts changes made meanwhile by you or by another agent in the same folder; it only undoes what the agent's own commands changed.",
    ],
  },
  {
    version: "0.8.0",
    date: "October 19, 2026",
    added: [
      "Fork a conversation from any reply to try another direction without losing the original.",
      "The context meter shows what the session has cost so far and how much was read from cache.",
      "Undoing a turn now also restores files changed by commands, not only by edits.",
      "The agent can search the whole conversation, including parts summarized to save space.",
      "A new verify agent works out how to build and test your project and checks a change before it's called done.",
      "Optional auto-formatting after each edit (prettier, biome, ruff, gofmt…) with format.enabled in settings.",
      "Run Nyxs from a terminal: app -p \"task\" --format json streams the agent's work as JSON lines.",
    ],
    improved: [
      "Much better use of the prompt cache: long sessions re-send far fewer tokens, so they are cheaper and faster.",
      "Long conversations are summarized while the agent works, and the summary keeps tool results, file paths and decisions.",
      "Real context window sizes and prices for many more models.",
      "Long web pages are read by a smaller model that returns only what was asked.",
      "Edits succeed more often when the indentation or spacing in the request doesn't match the file exactly.",
      "Instructions in AGENTS.md or NYXS.md inside subfolders are picked up when the agent works there, plus a personal ~/.nyxs/NYXS.md.",
      "Plan mode keeps read-only shell commands available.",
    ],
    fixed: [
      "The agent no longer repeats the same tool call over and over.",
      "Malformed or misnamed tool calls are repaired instead of failing.",
      "A stopped reply keeps the work it had done, so the next message continues from there.",
      "Permission rules in permissions.ask are applied.",
    ],
  },
  {
    version: "0.7.8",
    date: "October 19, 2026",
    added: [
      "Drag and drop files anywhere in the window to attach them to your message.",
    ],
    improved: [
      "Each session keeps its own side panel and browser tabs, so switching between projects no longer carries over another session's preview.",
    ],
    fixed: [
      "On macOS, voice dictation now asks for microphone access instead of failing silently.",
    ],
  },
  {
    version: "0.7.7",
    date: "October 19, 2026",
    added: [
      "Pink theme: pick it in Settings › General › Appearance, next to Light and Dark.",
    ],
  },
  {
    version: "0.7.6",
    date: "October 19, 2026",
    added: [
      "Claude Code keeps you posted: when a background task it left running finishes (a deploy, a CI run, a long command), its follow-up shows up in the chat instead of getting lost.",
    ],
    fixed: [
      "The model now answers in the language of your latest message, even when the app is set to another language.",
    ],
  },
  {
    version: "0.7.5",
    date: "October 19, 2026",
    fixed: [
      "Settings, dialogs and menus are no longer hidden behind a page open in the browser: the page steps aside while they're open.",
    ],
  },
  {
    version: "0.7.4",
    date: "October 19, 2026",
    fixed: [
      "Clicking Reply on selected text opens the reply box instead of closing it right away.",
      "Reloading the app no longer leaves an old browser page floating over the chat.",
    ],
  },
  {
    version: "0.7.3",
    date: "October 19, 2026",
    added: [
      "Reply to part of a message: select text in the chat, click Reply and send a message that quotes it.",
      "The element picker now works on websites and local servers open in the browser.",
    ],
    fixed: [
      "Each session keeps its own model and permission mode, so switching between sessions no longer changes them, and new sessions start with the permission mode you picked last.",
      "Local servers in the browser open at their real address, so apps whose server only accepts their own origin (CORS) can connect again.",
      "When you stop a server, its page closes and the browser shows the server list again.",
    ],
  },
  {
    version: "0.7.2",
    date: "October 19, 2026",
    added: [
      "Claude Code now offers every model your plan can pick, including earlier generations such as Opus 5, Opus 4.8 and Sonnet 4.6, not just the current four.",
      "Settings tells you when your Claude Code CLI is out of date and updates it for you, so new models show up as soon as Anthropic ships them.",
    ],
    fixed: [
      "Manage models: when several providers are connected, each one keeps its own model list instead of overwriting the others while they load.",
    ],
  },
  {
    version: "0.7.1",
    date: "October 18, 2026",
    fixed: [
      "On macOS and Linux, the preview now loads your dev server and HTML files.",
      "Typing an address like localhost:3000 in the browser opens your local server instead of looking for a file.",
      "On macOS, the window has the native close, minimize and full-screen buttons, and the green one goes full screen.",
    ],
  },
  {
    version: "0.7.0",
    date: "October 18, 2026",
    added: [
      "Agent in the browser: the agent can open pages in the built-in browser, read them, click, type, scroll and take screenshots, both on your dev server and on websites.",
      "Keep computer awake: a switch in the title bar's ⋮ menu stops your computer from sleeping while Nyxs works, until you turn it off or close the app.",
      "Model logos: models from a custom provider show their lab's logo, such as Qwen, DeepSeek, Llama, GLM or Kimi.",
    ],
    improved: [
      "Effort for Claude Code: the effort menu offers only the levels each model supports, marks the one Claude Code recommends, and hides itself for models without effort.",
      "Background tasks and plan view: they now open from the ⋮ button in the title bar.",
      "Faster menus: every menu opens instantly, and the model menu shows just the model names.",
      "Browser panel: websites stay visible while you resize the panel, and each tab keeps its page loaded in the background.",
    ],
  },
  {
    version: "0.6.0",
    date: "October 18, 2026",
    added: [
      "Tabs in the built-in browser: open a new one with + or Ctrl+T. Each tab keeps its own address and back/forward history.",
      "A browser settings menu (⋮): open the page in your default browser, copy its URL, save a screenshot, open an HTML file, preview at mobile, tablet or desktop size, choose how cookies are kept, manage allowed sites and clear browsing data.",
      "Servers from .claude/launch.json: the browser lists them and starts them in the right folder. A new servers menu shows which ones are running and stops them.",
      "A new Changes panel replaces the Review tab. It lists every changed file with colored change bars and a file tree, and opens quickly even for large diffs.",
      "Terminal, browser, files and What's new buttons in the title bar, with shortcuts: Ctrl+` for the terminal, Ctrl+Shift+B for the browser and Alt+←/→ to go back and forward.",
    ],
    improved: [
      "Several edits to the same file show up as one card, and the chat uses new colors with a softer, more compact bubble for your messages.",
      "The terminal and the browser keep running in the background when you switch views or close the panel.",
      "Links in the chat open in the built-in browser. You can turn this off from the browser menu.",
      "The Code / Chat switch moved to the title bar, and the Cowork section is gone.",
      "Tooltips show keyboard shortcuts and have softer corners.",
    ],
    fixed: [
      "The Changes panel no longer misses files when the diff is large.",
      "Ctrl+` opens the terminal on Spanish and other keyboard layouts.",
      "Launch servers with a quoted program path or their own working folder now start.",
    ],
  },
  {
    version: "0.5.0",
    date: "October 18, 2026",
    added: [
      "See your Claude plan usage: click the context ring to see what fills the context window and, with the Claude Code provider, your account's 5-hour and weekly limits and when they reset.",
      "A file explorer in the Files panel: browse the project tree with icons for each file type and read any file with line numbers and syntax highlighting.",
      "Dictate with the microphone: tap to start and tap again to transcribe, or hold it while you talk. A live level meter shows it is listening, Enter sends what you said, and right-click picks the microphone.",
      "Shell commands keep their full output in a log the assistant can read, and programs it starts in the background are cleaned up when they should be.",
    ],
    improved: [
      "A cleaner composer: folder, permission mode, model, effort and context sit under the input, the send button only appears when there is something to send, and the stop button shows its Esc shortcut.",
      "Questions and permission requests use a new compact card that you can answer from the keyboard.",
      "Permission modes are now Auto, Manual, Accept edits, Plan and Skip permissions, in that order.",
      "Model names show their provider's logo, and the context ring knows each Claude Code model's real window from the start of a chat.",
      "A blue accent, the Inter font built in, and dark tooltips across the app in light mode.",
      "Commands run in a persistent PowerShell session, so they start faster and report errors as plain text.",
    ],
    fixed: [
      "Git failures show their real cause, and new files appear in the diff panel.",
      "Closed or crashed sessions no longer leave PowerShell processes that re-run their last command.",
      "The labels under the input line up with each other.",
    ],
  },
  {
    version: "0.4.0",
    date: "October 16, 2026",
    added: [
      "Use your own Claude Pro or Max plan: the new Claude Code provider runs the official Claude Code CLI with your account. Connect it in one click from Settings → Providers (it installs Claude Code or signs you in through Anthropic's own page if needed), then pick any model your plan offers, including specific versions like Opus 4.8.",
      "Review the assistant's edits before keeping them: accept or reject each file, or each change inside a file, from the new Review tab.",
      "Queue messages while the assistant works: they go out in order when it finishes, and Ctrl+Enter interrupts and sends right away.",
      "Local MCP servers (the ones started with a command, like npx servers) now run inside Nyxs instead of being skipped, with a live status for each connector.",
      "Quick window, search across past sessions, and find-in-chat.",
    ],
    improved: [
      "A live status line shows what the assistant is doing (thinking, searching, writing), and finished steps fold into a single \"Worked for Xs\" line.",
      "Safer projects: settings, hooks and MCP servers that come with a project only apply after you trust them, and file access stays inside the folders you opened.",
      "More reliable shell commands: big outputs no longer hang, stopping kills everything the command started, and partial output is kept on timeout.",
      "Search and project indexing respect .gitignore, and secret files like .env are never sent for indexing.",
    ],
    fixed: [
      "Claude models now actually see images the assistant opens from your project.",
      "Esc no longer stops the assistant when you only meant to close a menu or dialog.",
      "Headings, quotes and nested lists in replies render correctly.",
    ],
  },
  {
    version: "0.3.7",
    date: "September 4, 2026",
    added: [
      "MiniMax over the Anthropic protocol is available as its own provider, with prompt caching for cheaper, faster follow-up turns.",
      "Each Google account now keeps its own conversations and settings, so switching accounts no longer mixes your work together.",
    ],
    improved: [
      "Noticeably faster replies: project context, MCP tools and git state are cached and refreshed in the background instead of being rebuilt before every message.",
      "Conversations are saved one file per chat and loaded on demand, so a long history no longer slows down startup or every save.",
    ],
    fixed: [
      "Custom providers on a local network address (for example a vLLM server at http://10.0.0.5:8000) no longer fail to load models with \"url not allowed on the configured scope\".",
    ],
  },
  {
    version: "0.3.5",
    date: "June 18, 2026",
    improved: [
      "Cleaner chat: a model's reasoning shows while it's thinking and tucks itself away once it moves on, so finished steps don't pile up.",
      "A burst of file reads now collapses into a single line instead of flooding the conversation.",
      "A typing cursor follows the live text and a clear \"Generating…\" state shows while the model is writing a file, so a slow model no longer looks frozen mid-sentence.",
    ],
    fixed: [
      "Large files no longer get cut off mid-write: the output-token limit is higher by default and adjustable (settings.json → generation.maxOutputTokens) for models that write big files in one go.",
    ],
  },
  {
    version: "0.3.4",
    date: "June 18, 2026",
    added: [
      "The assistant can now open image files (screenshots, mockups, diagrams) and actually see them on vision-capable models — just point it at the image.",
    ],
    improved: [
      "Vision-capable models from more providers (MiniMax-M3, Qwen-VL, Llama 4 and others) now see your attached images natively instead of via a text description.",
      "Sharper, safer file work: searches can return surrounding context in one step, and the assistant won't overwrite a file it hasn't read or that changed on disk underneath it.",
      "Cleaner live preview: Next.js projects no longer throw a hydration error in the in-app preview.",
    ],
    fixed: [
      "No more phantom \"Cannot find module\" errors: the assistant stops flagging — and trying to \"fix\" by installing packages or bumping versions — modules that simply aren't installed yet, and refreshes its checks after you run an install.",
    ],
  },
  {
    version: "0.3.3",
    date: "June 17, 2026",
    added: [
      "MiniMax provider: connect MiniMax directly with your API key and pick from its M-series reasoning models (M3, M2.5 and more).",
      "Live reasoning: a model's thinking now streams as it happens in its own collapsible block — with a separate block for each thinking phase instead of one big lump.",
    ],
    improved: [
      "Effort selector now controls how deeply MiniMax models reason, just like it does for other reasoning models.",
      "Smoother replies: after a model finishes thinking, its answer now streams in gradually instead of popping in all at once.",
      "Tidier questions: the multiple-choice prompt is more compact and lines up with the chat instead of stretching across the screen.",
      "Calmer notices: a recoverable tool hiccup now shows as a subtle note rather than an alarming red error box.",
    ],
    fixed: [
      "Reading PDFs now works on models without native PDF support — the text is extracted locally, so the assistant no longer stalls after opening a PDF.",
    ],
  },
  {
    version: "0.3.1",
    date: "June 5, 2026",
    added: [
      "Speed meter: each reply now shows tokens-per-second, so you can tell at a glance how fast a model or provider is actually streaming.",
      "Live write progress: creating a large file now shows its size, line count and elapsed time as it streams — the chat never looks frozen.",
    ],
    improved: [
      "Effort selector: it now controls reasoning for GLM and Kimi models — set it to Low and they answer immediately instead of thinking first, so they feel much faster.",
      "Smoother streaming: powerful models that used to deliver text in bursts now flow evenly instead of stuttering.",
      "Cleaner web output: large pages are split into separate index.html, styles.css and script.js files instead of one giant inline file.",
    ],
    fixed: [
      "Accented characters and ñ no longer get corrupted into � when a model writes files through the shell on Windows.",
      "A model's internal reasoning no longer leaks into the chat — it stays in the collapsible reasoning area, even for models that format it loosely.",
      "Large file writes no longer fail or loop on malformed-JSON or missing-path errors.",
      "Out-of-credit and quota-exceeded errors now stop immediately with a clear message instead of retrying pointlessly.",
    ],
  },
  {
    version: "0.3.0",
    date: "June 4, 2026",
    added: [
      "Archived sessions: sessions whose pull request was merged or closed tuck away on their own, and you can reopen or unarchive them anytime from a dedicated list.",
      "Richer preview: real websites that used to refuse to load (YouTube and others) now open in a native preview, not just local files and dev servers.",
      "Filter your Recents to quickly find the session you're after.",
    ],
    improved: [
      "Faster replies: the app now loads a session's context in parallel, so the model starts answering noticeably sooner each turn.",
      "Buttery-smooth output: large generations (a full HTML page, big files) stream without the lag and stutter they used to cause.",
      "The Changes and Files panels refresh on their own the moment a file changes — by you or the agent — no need to hit reload.",
      "The sidebar now reflects each session's state at a glance (running, waiting on you, idle).",
    ],
    fixed: [
      "Models served through OpenAI-compatible providers (Llama, Qwen and similar) no longer fail with a \"single tool-calls\" error mid-task.",
      "A glitch in one panel no longer blanks the whole app — it now recovers gracefully and tells you what happened.",
    ],
  },
  {
    version: "0.2.9",
    date: "June 3, 2026",
    added: [
      "Workflows: the agent can orchestrate many sub-agents to tackle big tasks in parallel, with live progress in a dedicated view.",
      "Git tools: the agent now reads your repo directly — status, diff, log and blame — for sharper, repo-aware help.",
      "Keyboard shortcuts: press Ctrl+/ to see them all, plus Ctrl+, for settings, Ctrl+N for a new session, and quick panel toggles.",
    ],
    improved: [
      "The command list (/help) now opens in a tidy modal instead of cluttering the chat.",
      "Connecting a provider is simpler — the base URL is preset for known providers and only editable for custom ones.",
    ],
    fixed: [
      "API-key fields no longer show a duplicate \"reveal\" eye on Windows.",
      "Removed a duplicate \"General\" entry from the settings sidebar.",
    ],
  },
  {
    version: "0.2.8",
    date: "June 3, 2026",
    added: [
      "Terminal: a real interactive PowerShell shell inside the app, with colors, line editing and interactive CLIs.",
      "Doctor: a /doctor health screen showing your version, workspace, models, API keys and MCP servers at a glance.",
    ],
    improved: [
      "Diagnostics: after the agent edits a file it runs your linter and gets the real errors back so it self-corrects.",
      "Grouped views: bursts of reads, searches, agents or commands now collapse into a single tidy view in the chat.",
      "Long conversations stay fast — old tool output is trimmed automatically before a full compaction is needed.",
      "Destructive commands (rm -rf, disk format, git reset --hard…) now always ask for confirmation before running.",
      "Search: filter files by name in the files panel.",
      "Skip an agent question instead of having to answer it.",
    ],
  },
  {
    version: "0.2.7",
    date: "June 2, 2026",
    added: [
      "Voice input: hold the mic button to talk and have your words transcribed straight into the chat.",
      "Effort selector: choose how hard the model thinks before answering, from Low to Max.",
    ],
    fixed: [
      "Scrolling up while the model is writing no longer yanks you back to the bottom.",
      "The \"Apply plan\" banner now appears only after a real plan has been written, not on any reply in plan mode.",
    ],
  },
  {
    version: "0.2.6",
    date: "June 2, 2026",
    improved: [
      "Maintenance re-release of the signed Windows build for a smoother auto-update.",
    ],
  },
  {
    version: "0.2.5",
    date: "June 2, 2026",
    added: [
      "Overclock tachometer: a live gauge that shows the model's output speed.",
    ],
    improved: [
      "The Windows installer is now code-signed, so it no longer triggers an \"unknown publisher\" warning.",
    ],
  },
  {
    version: "0.2.4",
    date: "June 1, 2026",
    added: [
      "Send feedback right from the app — report a bug, request a feature, or ask about billing, with an optional screenshot.",
      "Automatic chat titles: conversations now get a short, descriptive name.",
      "Account page: see your active sessions, sign out on all devices, and delete your account.",
      "Filter and sort connectors by type, category, and popularity.",
    ],
  },
  {
    version: "0.2.2",
    date: "May 31, 2026",
    added: [
      "Plugins panel — browse and install plugins from marketplaces.",
      "Skills directory — discover and install skills from the skills.sh ecosystem.",
      "Usage dashboard — see token spend by model with an activity heatmap.",
      "Customize hub in the sidebar to manage skills, connectors, and plugins in one place.",
      "Multi-language support — the app now speaks 10 languages.",
      "Light / dark / system theme switcher.",
      "Per-project sessions with chat history and rewind to an earlier snapshot.",
    ],
    improved: [
      "Connectors now show logos, categories, and trending info; Google Workspace sign-in via OAuth.",
    ],
  },
  {
    version: "0.2.1",
    date: "May 30, 2026",
    added: [
      "Changelog viewer — see what's new from the account menu.",
    ],
    fixed: [
      "Starting a dev server no longer opens a separate terminal window; its output stays in the in-app Terminal.",
    ],
  },
  {
    version: "0.2.0",
    date: "May 30, 2026",
    added: [
      "Automatic updates: Nyxs checks for new versions and shows an alert in the sidebar to install them.",
      "Attach an element from the live preview to your message as a compact chip — click it, then describe the change you want.",
      "One-click dev server: Nyxs remembers how to start your project and relaunches it from the preview pane.",
    ],
    fixed: [
      "The live preview no longer gets stuck on the loading screen when a dev server uses hot reload.",
    ],
  },
];
