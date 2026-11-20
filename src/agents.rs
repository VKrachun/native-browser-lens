//! Connects the coding agents on this computer to Lens: the `sirv-lens` skill where they read
//! skills, and the `sirv-lens` MCP server (`lens mcp`) in their MCP settings. Only agents that are
//! installed are touched, and `disconnect` takes back exactly what `connect` added.
use crate::investigate::program;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Stdio;
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

/// Whether the agents here have the sirv-lens skill: the sign that `connect` ran.
pub fn connected() -> bool {
    home().is_some_and(|home| {
        skill_folders(&home)
            .iter()
            .any(|folder| folder.join("SKILL.md").is_file())
    })
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
        if file.is_file() {
            let outcome = edit_json(&file, |servers| {
                servers.remove(NAME);
            })
            .map(|()| format!("MCP server removed from {}", shown(&file)));
            done.push(result(agent, outcome));
        }
    }
    done
}

fn run(program: &Path, args: &[&str]) -> Result<String, String> {
    // npm's claude.cmd and codex.cmd on Windows: run their node script, not cmd.exe's quoting.
    let output = crate::investigate::command(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("cannot start {}: {e}", program.display()))?;
    let said = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout).trim(),
        String::from_utf8_lossy(&output.stderr).trim()
    )
    .trim()
    .to_string();
    if output.status.success() {
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
    let mut settings: Value = match std::fs::read_to_string(file) {
        Ok(text) if !text.trim().is_empty() => serde_json::from_str(&text)
            .map_err(|e| format!("{} is not JSON ({e}); add the server by hand", shown(file)))?,
        _ => json!({}),
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
    std::fs::write(&fresh, text)
        .and_then(|()| match permissions {
            Some(permissions) => std::fs::set_permissions(&fresh, permissions),
            None => restrict(&fresh),
        })
        .and_then(|()| std::fs::rename(&fresh, &target))
        .map_err(|e| format!("cannot write {}: {e}", shown(file)))
}

/// A new settings file is readable by its owner only.
fn restrict(file: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600))
    }
    #[cfg(not(unix))]
    {
        let _ = file;
        Ok(())
    }
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
    }

    #[test]
    fn the_skill_names_itself() {
        assert!(SKILL.starts_with("---\nname: sirv-lens\ndescription: "));
    }
}
