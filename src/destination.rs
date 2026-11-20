//! Store only the address needed to open the team's draft form.
use crate::protocol::{TaskDestination, Tracker};
use url::Url;

pub fn normalize(mut choice: TaskDestination) -> Result<TaskDestination, &'static str> {
    if matches!(
        choice.tracker,
        Tracker::Linear | Tracker::Clipboard | Tracker::Vibeq
    ) {
        choice.address.clear();
        return Ok(choice);
    }
    let mut url = Url::parse(choice.address.trim()).map_err(|_| "Enter the full HTTPS address.")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err("Use an HTTPS address without credentials or a port.");
    }
    let host = url.host_str().unwrap_or_default();
    let path: Vec<_> = url.path().trim_matches('/').split('/').collect();
    match choice.tracker {
        Tracker::Jira => {
            if !host
                .strip_suffix(".atlassian.net")
                .is_some_and(|team| !team.is_empty() && !team.contains('.'))
            {
                return Err("Enter your Jira Cloud site, such as https://team.atlassian.net.");
            }
            choice.address = url.origin().ascii_serialization();
        }
        Tracker::Github => {
            if host != "github.com"
                || !matches!(
                    &path[..],
                    [_, _] | [_, _, "issues"] | [_, _, "issues", "new"]
                )
                || !path[..2].iter().all(|v| {
                    !v.is_empty()
                        && v.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"-._".contains(&b))
                })
            {
                return Err("Enter the GitHub repository URL.");
            }
            choice.address = format!("https://github.com/{}/{}", path[0], path[1]);
        }
        Tracker::Basecamp => {
            let id = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
            let valid = match &path[..] {
                [account, "buckets", project, "todolists", list]
                | [
                    account,
                    "buckets",
                    project,
                    "todolists",
                    list,
                    "todos",
                    "new",
                ] => id(account) && id(project) && id(list),
                [account, "buckets", project, "todos", "new"] => id(account) && id(project),
                _ => false,
            };
            if !matches!(host, "app.basecamp.com" | "3.basecamp.com") || !valid {
                return Err("Enter your Basecamp to-do list or new to-do form URL.");
            }
            if path.last() != Some(&"new") {
                url.set_query(None);
            }
            url.set_fragment(None);
            choice.address = url.to_string();
        }
        _ => unreachable!(),
    }
    Ok(choice)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn address(tracker: Tracker, address: &str) -> Result<String, &'static str> {
        normalize(TaskDestination {
            tracker,
            address: address.into(),
        })
        .map(|d| d.address)
    }

    #[test]
    fn stores_only_the_destination_needed_by_every_browser() {
        assert_eq!(
            address(
                Tracker::Github,
                "https://github.com/team/private/issues?query=private"
            )
            .unwrap(),
            "https://github.com/team/private"
        );
        assert_eq!(
            address(Tracker::Jira, "https://team.atlassian.net/browse/ABC-1").unwrap(),
            "https://team.atlassian.net"
        );
        assert_eq!(
            address(Tracker::Clipboard, "https://old.example").unwrap(),
            ""
        );
        assert!(address(Tracker::Github, "https://other.example/team/repo").is_err());
        assert!(address(Tracker::Basecamp, "https://app.basecamp.com/1/buckets/2").is_err());
        assert!(address(Tracker::Jira, "https://user:pass@team.atlassian.net").is_err());
    }
}
