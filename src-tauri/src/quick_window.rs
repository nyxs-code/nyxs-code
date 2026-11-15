use tauri::{AppHandle, Emitter, Manager, Runtime, Webview, WebviewUrl, WebviewWindowBuilder};

pub const QUICK_LABEL: &str = "quick";
const MAIN_LABEL: &str = "main";

fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, QUICK_LABEL, WebviewUrl::default())
        .title("Nyxs")
        .inner_size(680.0, 168.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .visible(false)
        // Built hidden at start-up: taking focus here made this invisible window the
        // foreground one, so the main window lost the keyboard. `reveal` focuses it.
        .focused(false)
        .build()?;
    Ok(())
}

fn reveal<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(QUICK_LABEL) {
        let _ = w.center();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = AsRef::<Webview<R>>::as_ref(&w).set_focus();
        let _ = w.emit_to(QUICK_LABEL, "quick:shown", ());
    }
}

pub fn prewarm<R: Runtime>(app: &AppHandle<R>) {
    if app.get_webview_window(QUICK_LABEL).is_some() {
        return;
    }
    if let Err(err) = build(app) {
        log::error!("couldn't create the quick window: {err}");
    }
}

pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    match app.get_webview_window(QUICK_LABEL) {
        Some(w) if w.is_visible().unwrap_or(false) => {
            let _ = w.hide();
        }
        Some(_) => reveal(app),
        None => {
            prewarm(app);
            reveal(app);
        }
    }
}

#[tauri::command]
pub fn quick_hide<R: Runtime>(app: AppHandle<R>) {
    if let Some(w) = app.get_webview_window(QUICK_LABEL) {
        let _ = w.hide();
    }
}

#[tauri::command]
pub fn quick_submit<R: Runtime>(app: AppHandle<R>, prompt: String) -> Result<(), String> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Ok(());
    }
    quick_hide(app.clone());
    let main = app
        .get_webview_window(MAIN_LABEL)
        .ok_or_else(|| "the main window isn't available".to_string())?;
    let _ = main.unminimize();
    let _ = main.show();
    let _ = main.set_focus();
    main.emit_to(MAIN_LABEL, "quick:prompt", prompt)
        .map_err(|e| e.to_string())
}

#[cfg(desktop)]
pub fn register_shortcut<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_global_shortcut::{
        Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
    };

    // A development build adds Alt, so it doesn't fight an installed Nyxs open at the same time
    // for Ctrl+Shift+Space (the second one to start couldn't register it).
    let modifiers = if cfg!(debug_assertions) {
        Modifiers::CONTROL | Modifiers::SHIFT | Modifiers::ALT
    } else {
        Modifiers::CONTROL | Modifiers::SHIFT
    };
    let shortcut = Shortcut::new(Some(modifiers), Code::Space);
    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app, pressed, event| {
            if pressed == &shortcut && event.state() == ShortcutState::Pressed {
                toggle(app);
            }
        })
        .build();
    if let Err(err) = app.plugin(plugin) {
        log::error!("couldn't start the global shortcuts plugin: {err}");
        return;
    }
    if let Err(err) = app.global_shortcut().register(shortcut) {
        let keys = if cfg!(debug_assertions) {
            "Ctrl+Shift+Alt+Space"
        } else {
            "Ctrl+Shift+Space"
        };
        log::warn!("{keys} is already in use by another app: {err}");
    }
}
