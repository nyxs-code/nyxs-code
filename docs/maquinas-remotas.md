# Máquinas remotas (SSH)

Trabajar en una máquina remota (una VPS, el PC de casa) desde cualquier PC como si fuera uno
solo: el código, los comandos, la terminal, el LSP, los CLIs y las sesiones viven en esa
máquina, y Nyxs en cada PC es la pantalla. Este documento explica cómo está hecho, cómo
probarlo y qué falta, para retomarlo.

## Cómo se usa

1. En el composer de una sesión nueva, el chip **Local** abre "Dónde trabaja": este equipo,
   las máquinas guardadas y "Añadir máquina SSH…".
2. La máquina se escribe como tras `ssh`: un alias de `~/.ssh/config`, `usuario@servidor` o
   `usuario@servidor:2222`. Se entra con las claves SSH o ssh-agent del usuario; si la máquina
   pide contraseña (o la clave, su frase), Nyxs la pregunta en un diálogo, y solo la guarda
   en el llavero del sistema si se marca «Recordar en este equipo».
3. Al conectar se abre el explorador de carpetas de la máquina (con "Nueva carpeta"); la
   carpeta elegida es el proyecto, `ssh://maquina/ruta`.

## Arquitectura

**Nombre de las rutas.** Un proyecto remoto es `ssh://<host>/<ruta>`: `<host>` es lo que
recibe `ssh` y `<ruta>` la ruta absoluta allí con `/` (`ssh://casa/C:/code/app` en Windows).
Rust: `src-tauri/src/remote/uri.rs`. TypeScript: `src/lib/remote.ts` (`parseRemote`,
`resolveRemotePath`, `isInsideRemote`).

**El ayudante (`nyxs-remote`).** Crate aparte en `src-tauri/remote/` (su propio workspace).
Corre en la máquina remota con `nyxs-remote serve` y habla JSON por líneas en stdin/stdout:
una petición `{"id","op",...}` y una respuesta `{"id","ok"|"err"}`; los procesos largos
mandan eventos (`out`, `exit`, `changed`). Operaciones: `hello`, `stat`, `read`, `write`
(atómica, conserva permisos), `listDir`, `mkdir`, `remove`, `rename`, `listFiles`, `glob`,
`grep`, `walkText` (RAG), `exec` (+`cancel`; con `binary` devuelve la salida en base64, byte a
byte), `spawn`/`stdin`/`kill`, `tcp`, `watch`, `realpath`, `resolve`. En el PC del usuario,
el mismo binario hace de `SSH_ASKPASS` (ver «La conexión»). Glob y Grep usan el mismo código que la app (`src-tauri/src/agent/search_core.rs`
y `src-tauri/src/walk.rs`, incluidos con `#[path]`), así que la salida es idéntica.

**Instalación y actualización.** `remote/install.rs`: averigua el sistema y el procesador
(`echo %OS%... & uname -sm`), elige el binario de `remote/dist/nyxs-remote-<os>-<arch>` y lo
copia a `~/.nyxs-remote/<versión>-<huella>/` (huella = SHA-256 del binario). Si el binario
cambia, la carpeta no existe y se reinstala solo al conectar; tras instalar se borran las
versiones viejas (otro PC con otra versión la reinstala solo). Lo último que se supo de cada
máquina se guarda en `~/.nyxs/remote/targets.json`.

**La conexión.** `remote/conn.rs`: un `ssh -T` persistente por máquina (OpenSSH del sistema,
el de System32 en Windows), con `StrictHostKeyChecking=accept-new` (la primera vez se acepta
la clave de la máquina; si cambia después, se rechaza). Contraseñas y frases de clave:
`remote/askpass.rs` da a cada `ssh`/`scp`/túnel `SSH_ASKPASS` (+`SSH_ASKPASS_REQUIRE=force`)
apuntando al ayudante de este PC, que pregunta a Nyxs por un puerto local con un token propio
de ese `ssh`; Nyxs abre `SshAskpassDialog.tsx` (evento `ssh-askpass`, respuesta
`ssh_askpass_answer`). La respuesta se guarda 2 min en memoria para las demás llamadas de la
misma conexión (sondeo, copia del ayudante, `serve`) y en el llavero solo si se marca
«Recordar». Si el mismo `ssh` vuelve a preguntar, la respuesta era mala: se olvida y el
diálogo lo dice. Sin ayudante para este PC queda `BatchMode=yes`. La espera de 45 s a que
arranque el ayudante no cuenta el rato del diálogo.
`remote/mod.rs` abre la conexión la primera vez que algo la necesita y emite `remote-status`
(`connecting`, `installing`, `connected`, `disconnected`, `error`).

**Cómo llegan los comandos a la máquina.**
- `src-tauri/src/agent/vfs.rs`: equivalentes de `std::fs` que aceptan rutas locales o
  `ssh://`. Read, Write, Edit, MultiEdit, ListDir, el editor, la vista previa, PDFs,
  imágenes, ajustes del proyecto, skills, NYXS.md, revisiones e historial de archivos pasan
  por aquí.
- Comandos: `agent_run`, `agent_git`/`agent_exec` (`shell/run.rs`) y los de segundo plano
  (`shell/background.rs`, `BgChild::Remote`) usan `remote::procs`.
- Permisos de rutas: `confine_remote` en `agent/scope.rs` (dentro de las raíces `ssh://` del
  ámbito, o en `~/.nyxs` de la máquina). Como en local, se siguen los symlinks: la ruta y las
  raíces se resuelven en la máquina con la op `resolve` (una llamada, con caché de 30 s por ruta).
- Sesiones e historial: `project_paths::project_data_dir_str` guarda los de un proyecto
  remoto en esa máquina, en `~/.nyxs/projects/<ruta codificada>`, la misma carpeta que usaría
  Nyxs instalado allí. Por eso dos PCs ven las mismas sesiones.
- Terminal: `pty.rs` abre `ssh -tt` con la shell de la máquina en la carpeta del proyecto (con
  terminal propia, así que una contraseña se pide allí mismo).
- Worktrees: `worktree_remote.rs` (desde `worktree.rs`): los de sesión y los de subagentes
  viven en la máquina, en `~/.nyxs/worktree/<proyecto>/<id>` (o bajo la ubicación de Ajustes
  si empieza por `~/` o es una ruta absoluta de ese sistema). El estado sin confirmar se lleva
  al worktree de un subagente con un índice temporal y `read-tree`, y los parches van a
  `git apply` por stdin, para no hacer un viaje por archivo.
- Fotos en sombra («Revertir», rebobinar, cambios de los comandos de shell):
  `agent/shadow_git_remote.rs`, el mismo repositorio desnudo en
  `~/.nyxs/projects/<proyecto>/snapshots` de la máquina.
- Vigilante del panel de archivos: `fswatch.rs` → op `watch` del ayudante (`listen` en
  `remote/src/main.rs`), que escucha los eventos del sistema: inotify en Linux (una vigilancia
  por carpeta del proyecto, sin las ignoradas), y en Windows (`ReadDirectoryChangesW`) y
  macOS (FSEvents) una sola vigilancia recursiva cuyos eventos de carpetas ignoradas se
  descartan. Manda un `changed` como mucho cada 300 ms (`Batch`). Si la vigilancia no puede
  arrancar (carpeta inexistente o sin permiso, un recurso de red sin eventos, inotify sin
  vigilancias), sondea cada 2 s y lo dice en su stderr, que la app copia en su log.
- LSP: `lsp/server.rs` arranca el servidor en la máquina (`LspChild::Remote`) y traduce URIs
  `ssh://` ↔ `file://` (`to_server_uri`, `app_uri`, `app_uris`).
- Claude Code y los demás CLIs: `cli_process::spawn_remote_cli` (`CliChild::Remote`). Claude
  Code se prepara solo en el primer turno (`agent/claude_code/remote.rs`, `lib/remoteClaude.ts`):
  se instala o actualiza con su instalador y solo pide iniciar sesión, con el navegador de este
  PC y un túnel al puerto de `claude auth login`; si el túnel no puede, con un código. Los demás
  CLIs deben estar instalados y con sesión iniciada en la máquina.
- Servidores de desarrollo: `launchConfig.ts` escribe el comando para el sistema de la máquina
  y cambia una ruta de Windows por el nombre del programa. Antes de arrancar uno de Node,
  `remote/node.rs` y `lib/remoteServerPrep.ts` miran qué falta: las dependencias se instalan
  solas y Node, con confirmación, en `~/.local/share/nyxs/node`, sin administrador y con
  enlaces en `~/.local/bin`, que el ayudante añade al PATH de lo que ejecuta.
- RAG: `rag.rs` pide los textos con `walkText`; el índice queda en este PC.
- Navegador: `remote/tunnel.rs` abre `ssh -N -L`; `agent_wait_for_server` (con `cwd`), la
  barra de direcciones (`usePageAddress.ts`) y la herramienta `navigate` del agente
  (`browserTools.ts`, `tunnelUrl`) mandan `localhost` de un proyecto remoto por el túnel.
  `agent_stop_port`/`agent_port_listeners` actúan en la máquina si el puerto es un túnel.
  Los archivos del proyecto (un `.html`, un README) los sirve el proxy de la vista previa
  leyendo con `vfs` (`Site::RemoteRoot` en `agent/preview.rs`).
- Abrir en el editor: VS Code/Cursor con `--remote ssh-remote+<host>`.
- Prompt: `hostPlatform(workspace)` en `src/tools/env.ts` da el sistema y la shell de la
  máquina, y el prompt del sistema avisa de que todo corre allí.

**Interfaz.** `src/components/ui/chat-input/`: `WorkspaceChips.tsx` (máquina + carpeta +
worktree), `MachineSelector.tsx`, `RemoteMachineDialog.tsx`, `RemoteFolderDialog.tsx`.
Textos en `remote` de cada locale.

**Release.** El job `remote-helpers` de `.github/workflows/release.yml` compila los 6
ayudantes (Linux x86_64/ARM64 estáticos con zig, Windows x86_64/ARM64, macOS Intel/Apple
Silicon) y `bundle.resources` (`remote/dist/*`) los mete en cada instalador. En desarrollo,
`tauri dev` reconstruye el de este PC y el de Linux x86_64 si son más viejos que sus fuentes
(`remote/dist` no está en git); `npm run remote:build` lo hace a mano. Docker queda como
respaldo: el de Linux se enlaza con `rust-lld`.

## Cómo probarlo

- Unitarias: `cargo test --lib` y `npx vitest run` (`src/lib/__tests__/remote.test.ts`,
  `src/components/ui/chat-input/__tests__/MachineSelector.test.tsx`).
- Contra una máquina real (pruebas `#[ignore]` del módulo `live` en `src-tauri/src/remote/mod.rs`):
  `NYXS_SSH_CONFIG=<ssh_config> NYXS_REMOTE_TEST_HOST=<host> cargo test --lib remote::live -- --ignored --test-threads=1`.
  `NYXS_SSH_CONFIG` hace que Nyxs use otro `ssh_config` en vez de `~/.ssh/config`. Se
  probaron contra un contenedor Ubuntu con `openssh-server`, `node` y `git` (usuario `dev` con
  una clave propia en el puerto 2222). La prueba del LSP necesita `typescript-language-server`
  y `typescript@5` en la máquina (TypeScript 7 ya no trae `tsserver.js`). La de contraseña
  (`a_machine_that_takes_only_a_password`) necesita además `NYXS_REMOTE_PASSWORD_HOST` (un
  host del mismo `ssh_config` con `PubkeyAuthentication no`) y `NYXS_REMOTE_PASSWORD`.
- De punta a punta con el agente: `app.exe -p "<tarea>" --format json --cwd ssh://<host>/<ruta> --permission-mode skip --model <id>`.

## Pendiente

En orden de prioridad para el uso real (PC de casa con Windows como servidor).

1. **Probar contra un servidor Windows real (OpenSSH Server).** Solo se probó Linux. Falta
   comprobar en un PC con "Servidor OpenSSH" activado: la detección (`parse_probe`), la copia
   por `scp` a `.nyxs-remote\<versión>` (`install.rs`), el arranque con `cmd`
   (`helper_command`), la limpieza de versiones viejas con `for /d`, la terminal
   (`terminal_argv`: `cd /d … && powershell`) y los comandos en PowerShell
   (`shell_program` del ayudante). Si la shell por defecto de ese sshd es PowerShell en vez de
   `cmd`, revisar cada comando de `install.rs`.
2. **Que los procesos sobrevivan a cortar la conexión.** Hoy el ayudante mata todo al cerrarse
   su stdin (`kill_all` en `remote/src/main.rs`), así que cerrar el portátil detiene un
   servidor de desarrollo o un turno de Claude Code. Idea: un modo demonio del ayudante (un
   proceso por máquina y usuario, con socket local) al que cada `serve` se conecta como
   cliente; los procesos pertenecen al demonio, que guarda su salida, y al reconectar la app
   lista los procesos vivos y se vuelve a enganchar (los turnos de Claude Code ya saben
   reengancharse tras recargar la página: `claude_code_attach`).
3. **Probar el vigilante de archivos en un Mac real.** Con FSEvents desde el 2026-10-31; en
   Windows y Linux está probado.

Otros detalles conocidos:
- Las sesiones del otro PC aparecen cuando el proyecto remoto se ha abierto allí una vez (la
  barra lateral lista las carpetas recientes de cada PC).
- `term_busy` no ve qué corre dentro de una terminal remota (su proceso es `ssh`), así que
  cerrarla no avisa de un programa en marcha.
- Abrir o mostrar un archivo remoto en el explorador de archivos del sistema no es posible;
  se ofrece abrirlo en VS Code/Cursor.
