//! Connects the coding agents on this computer to Lens: the `sirv-lens` skill where they read
//! skills, and the `sirv-lens` MCP server (`lens mcp`) in their MCP settings. Only agents that are
//! installed are touched, and `disconnect` takes back exactly what `connect` added.
use crate::investigate::program;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use ts_rs::TS;

pub const SKILL: &str = include_str!("../plugin/skills/sirv-lens/SKILL.md");
const NAME: &str = "sirv-lens";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AgentSetup {
    /// The agent, or the skill folder, such as "Claude Code" or "~/.agents/skills".
    pub agent: String,
    pub ok: bool,
    /// What was done, or why not.
    pub detail: String,
}

fn home() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|b| b.home_dir().to_path_buf())
}

/// The skill folders: Claude Code's, and the shared one that Codex and other agents read. Only
/// folders whose agent folder exists, so no agent gets a folder it never asked for.
fn skill_folders(home: &Path) -> Vec<PathBuf> {
    [".claude", ".agents"]
        .into_iter()
        .map(|agent| home.join(agent))
        .filter(|agent| agent.is_dir())
        .map(|agent| agent.join("skills").join(NAME))
        .collect()
}

/// JSON MCP settings that other agents keep: Cursor and Gemini CLI.
fn json_settings(home: &Path) -> Vec<(&'static str, PathBuf)> {
    [
        ("Cursor", home.join(".cursor"), "mcp.json"),
        ("Gemini CLI", home.join(".gemini"), "settings.json"),
    ]
    .into_iter()
    .filter(|(_, folder, _)| folder.is_dir())
    .map(|(name, folder, file)| (name, folder.join(file)))
    .collect()
}

fn shown(path: &Path) -> String {
    match home().and_then(|h| path.strip_prefix(h).ok().map(Path::to_path_buf)) {
        Some(inside) => format!("~/{}", inside.display()),
        None => path.display().to_string(),
    }
}

fn result(agent: impl Into<String>, outcome: Result<String, String>) -> AgentSetup {
    let (ok, detail) = match outcome {
        Ok(detail) => (true, detail),
        Err(detail) => (false, detail),
    };
    AgentSetup {
        agent: agent.into(),
        ok,
        detail,
    }
}

/// Whether an agent here has the sirv-lens skill or MCP server: the sign that `connect` ran.
pub fn connected() -> bool {
    home().is_some_and(|home| connected_in(&home))
}

fn connected_in(home: &Path) -> bool {
    // Codex keeps its servers in TOML, as [mcp_servers.sirv-lens].
    let codex = std::fs::read_to_string(home.join(".codex/config.toml")).is_ok_and(|text| {
        text.lines().map(str::trim).any(|line| {
            line == format!("[mcp_servers.{NAME}]") || line == format!("[mcp_servers.\"{NAME}\"]")
        })
    });
    codex
        || skill_folders(home)
            .iter()
            .any(|folder| folder.join("SKILL.md").is_file())
        || json_settings(home).iter().any(|(_, file)| has_server(file))
}

/// Whether a JSON settings file lists the sirv-lens server.
fn has_server(file: &Path) -> bool {
    std::fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_some_and(|settings| settings["mcpServers"].get(NAME).is_some())
}

/// Adds the skill and the MCP server for every agent found. `lens` is the program agents start.
pub fn connect(lens: &Path) -> Vec<AgentSetup> {
    let Some(home) = home() else {
        return vec![result("Lens", Err("no home folder".into()))];
    };
    let lens = lens.display().to_string();
    let mut done = Vec::new();
    for folder in skill_folders(&home) {
        let outcome = std::fs::create_dir_all(&folder)
            .and_then(|()| std::fs::write(folder.join("SKILL.md"), SKILL))
            .map(|()| "skill installed".to_string())
            .map_err(|e| format!("cannot write the skill: {e}"));
        done.push(result(shown(folder.parent().unwrap_or(&folder)), outcome));
    }
    // A server from an older Lens path is replaced, so the program moves with the install.
    if let Some(claude) = program("claude") {
        let _ = run(&claude, &["mcp", "remove", "--scope", "user", NAME]);
        let outcome = run(
            &claude,
            &["mcp", "add", "--scope", "user", NAME, "--", &lens, "mcp"],
        )
        .map(|_| "MCP server added (user scope)".to_string());
        done.push(result("Claude Code", outcome));
    }
    if let Some(codex) = program("codex") {
        let _ = run(&codex, &["mcp", "remove", NAME]);
        let outcome = run(&codex, &["mcp", "add", NAME, "--", &lens, "mcp"])
            .map(|_| "MCP server added".to_string());
        done.push(result("Codex", outcome));
    }
    for (agent, file) in json_settings(&home) {
        let outcome = edit_json(&file, |servers| {
            servers.insert(NAME.into(), json!({ "command": lens, "args": ["mcp"] }));
        })
        .map(|()| format!("MCP server added to {}", shown(&file)));
        done.push(result(agent, outcome));
    }
    if done.is_empty() {
        done.push(result(
            "Lens",
            Err("no coding agent found (Claude Code, Codex, Cursor or Gemini CLI)".into()),
        ));
    }
    done
}

/// Removes what `connect` added. Other skills and servers stay.
pub fn disconnect() -> Vec<AgentSetup> {
    let Some(home) = home() else {
        return vec![result("Lens", Err("no home folder".into()))];
    };
    let mut done = Vec::new();
    for folder in skill_folders(&home) {
        if folder.join("SKILL.md").is_file() {
            let outcome = std::fs::remove_dir_all(&folder)
                .map(|()| "skill removed".to_string())
                .map_err(|e| format!("cannot remove the skill: {e}"));
            done.push(result(shown(folder.parent().unwrap_or(&folder)), outcome));
        }
    }
    if let Some(claude) = program("claude") {
        let outcome = run(&claude, &["mcp", "remove", "--scope", "user", NAME])
            .map(|_| "MCP server removed".to_string());
        done.push(result("Claude Code", outcome));
    }
    if let Some(codex) = program("codex") {
        let outcome =
            run(&codex, &["mcp", "remove", NAME]).map(|_| "MCP server removed".to_string());
        done.push(result("Codex", outcome));
    }
    for (agent, file) in json_settings(&home) {
        if has_server(&file) {
            let outcome = edit_json(&file, |servers| {
                servers.remove(NAME);
            })
            .map(|()| format!("MCP server removed from {}", shown(&file)));
            done.push(result(agent, outcome));
        }
    }
    done
}

/// Runs the agent's CLI as investigations do: the PATH that finds its node under launchd or
/// systemd, npm's .cmd files on Windows run as their node script, and a time limit.
fn run(program: &Path, args: &[&str]) -> Result<String, String> {
    let (success, output) = crate::investigate::run_with(
        program,
        args,
        None,
        None,
        std::time::Duration::from_secs(60),
        true,
    )?;
    let said = String::from_utf8_lossy(&output).trim().to_string();
    if success {
        Ok(said)
    } else {
        Err(said.lines().last().unwrap_or("it failed").to_string())
    }
}

/// Changes `mcpServers` in a JSON settings file and keeps everything else. A file that is not
/// JSON is left alone.
fn edit_json(
    file: &Path,
    change: impl FnOnce(&mut serde_json::Map<String, Value>),
) -> Result<(), String> {
    // Only a missing file is empty; one Lens cannot read stays as it is.
    let text = match std::fs::read_to_string(file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("cannot read {}: {e}", shown(file))),
    };
    let mut settings: Value = if text.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(&text)
            .map_err(|e| format!("{} is not JSON ({e}); add the server by hand", shown(file)))?
    };
    let root = settings
        .as_object_mut()
        .ok_or_else(|| format!("{} is not a JSON object", shown(file)))?;
    let servers = root
        .entry("mcpServers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| format!("mcpServers in {} is not an object", shown(file)))?;
    change(servers);
    let text = serde_json::to_string_pretty(&settings).expect("JSON serializes") + "\n";
    // A linked settings file is changed where it lives, and keeps its permissions: settings can
    // hold API keys.
    let target = std::fs::canonicalize(file).unwrap_or_else(|_| file.to_path_buf());
    let fresh = target.with_extension("lens-new");
    let permissions = std::fs::metadata(&target).map(|m| m.permissions()).ok();
    // A copy left by an earlier failure goes first, so the new one is made readable by its
    // owner only before the settings are in it.
    let _ = std::fs::remove_file(&fresh);
    let written = create_private(&fresh)
        .and_then(|mut new| std::io::Write::write_all(&mut new, text.as_bytes()))
        .and_then(|()| match permissions {
            Some(permissions) => std::fs::set_permissions(&fresh, permissions),
            None => Ok(()),
        })
        .and_then(|()| std::fs::rename(&fresh, &target));
    if written.is_err() {
        let _ = std::fs::remove_file(&fresh);
    }
    written.map_err(|e| format!("cannot write {}: {e}", shown(file)))
}

/// A new file that only its owner can read.
fn create_private(file: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_settings_keep_what_is_there() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("mcp.json");
        std::fs::write(
            &file,
            r#"{"theme":"dark","mcpServers":{"other":{"command":"x"}}}"#,
        )
        .unwrap();
        edit_json(&file, |servers| {
            servers.insert(
                NAME.into(),
                json!({ "command": "/opt/lens", "args": ["mcp"] }),
            );
        })
        .unwrap();
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(saved["theme"], "dark");
        assert_eq!(saved["mcpServers"]["other"]["command"], "x");
        assert_eq!(saved["mcpServers"][NAME]["args"][0], "mcp");
        edit_json(&file, |servers| {
            servers.remove(NAME);
        })
        .unwrap();
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert!(saved["mcpServers"].get(NAME).is_none());
        assert_eq!(saved["mcpServers"]["other"]["command"], "x");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
            edit_json(&file, |_| {}).unwrap();
            let mode = std::fs::metadata(&file).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
            let link = folder.path().join("linked.json");
            std::os::unix::fs::symlink(&file, &link).unwrap();
            edit_json(&link, |servers| {
                servers.insert("via-link".into(), json!({}));
            })
            .unwrap();
            assert!(
                std::fs::symlink_metadata(&link)
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
            assert!(std::fs::read_to_string(&file).unwrap().contains("via-link"));
        }

        std::fs::write(&file, "{ not json").unwrap();
        assert!(edit_json(&file, |_| {}).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{ not json");
        // A file Lens cannot read is not an empty one.
        std::fs::write(&file, b"{\"key\":\"\xff\"}").unwrap();
        assert!(edit_json(&file, |_| {}).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), b"{\"key\":\"\xff\"}");
        assert!(!file.with_extension("lens-new").exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let new = folder.path().join("new.json");
            edit_json(&new, |_| {}).unwrap();
            let mode = std::fs::metadata(&new).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn any_agent_with_the_server_or_skill_counts_as_connected() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        assert!(!connected_in(home));
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::write(home.join(".codex/config.toml"), "[mcp_servers.other]\n").unwrap();
        assert!(!connected_in(home));
        std::fs::write(
            home.join(".codex/config.toml"),
            "[mcp_servers.sirv-lens]\ncommand = \"lens\"\n",
        )
        .unwrap();
        assert!(connected_in(home), "Codex only");
        std::fs::remove_file(home.join(".codex/config.toml")).unwrap();
        std::fs::create_dir_all(home.join(".gemini")).unwrap();
        std::fs::write(home.join(".gemini/settings.json"), r#"{"mcpServers":{}}"#).unwrap();
        assert!(!connected_in(home));
        std::fs::write(
            home.join(".gemini/settings.json"),
            r#"{"mcpServers":{"sirv-lens":{"command":"lens"}}}"#,
        )
        .unwrap();
        assert!(connected_in(home), "Gemini CLI only");
    }

    #[test]
    fn the_skill_names_itself() {
        assert!(SKILL.starts_with("---\nname: sirv-lens\ndescription: "));
    }
}
