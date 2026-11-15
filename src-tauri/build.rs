fn main() {
    // A dependency imports `TaskDialogIndirect`, which only Common Controls v6 has. The app's
    // manifest (tauri_build, added to the binary only) asks for v6, but the test binary has
    // none, so on Windows it didn't start (STATUS_ENTRYPOINT_NOT_FOUND). Loading comctl32 on
    // first use instead of at start-up lets the tests run; the app still gets v6 through its
    // manifest when a dialog needs it.
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") && msvc {
        println!("cargo:rustc-link-arg=/DELAYLOAD:comctl32.dll");
        println!("cargo:rustc-link-lib=delayimp");
    }
    tauri_build::build()
}
