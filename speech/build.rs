fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    #[cfg(target_os = "macos")]
    link_clang_rt();
}

/// Objective-C `@available` checks (e.g. Metal 15+ guards in ggml-metal when targeting macOS 11.0)
/// emit calls to `___isPlatformVersionAtLeast`, which lives in Clang's compiler-rt archive. Rust
/// links with `-nodefaultlibs`, so `cc` does not add `libclang_rt.osx.a` on its own.
#[cfg(target_os = "macos")]
fn link_clang_rt() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let output = std::process::Command::new("xcrun")
        .args(["clang", "--print-resource-dir"])
        .output()
        .expect("xcrun clang --print-resource-dir");
    assert!(
        output.status.success(),
        "xcrun clang --print-resource-dir failed"
    );
    let resource_dir = String::from_utf8(output.stdout).expect("utf-8 clang resource dir");
    let lib_dir = std::path::Path::new(resource_dir.trim()).join("lib/darwin");
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=static=clang_rt.osx");
}
