//! Commands for coding agents and scripts: the reviews a person approved, as JSON or as a folder
//! of files. They read the same frozen reviews as the MCP server, and `agents` connects the coding
//! agents on this computer to Lens.
use crate::client::Client;
use crate::paths::Paths;
use crate::protocol::{Reply, Request, Review};
use std::io::{self, Write};
use std::path::PathBuf;

fn ask(client: &mut Client, request: Request) -> io::Result<Reply> {
    client.call(request).map_err(io::Error::other)
}

fn review(client: &mut Client, id: &str) -> io::Result<Review> {
    let id = id
        .parse()
        .map_err(|_| io::Error::other(format!("{id:?} is not a review id (see lens reviews)")))?;
    match ask(client, Request::GetReview { review: id })? {
        Reply::Review(review) => Ok(review),
        _ => Err(io::Error::other("unexpected reply")),
    }
}

/// `lens reviews [--json]`: newest first, with the VibeQ task each was filed as.
pub fn reviews(paths: &Paths, json: bool) -> io::Result<()> {
    let mut client = Client::connect(paths)?;
    let Reply::Reviews(reviews) = ask(&mut client, Request::ListReviews)? else {
        return Err(io::Error::other("unexpected reply"));
    };
    let mut out = io::stdout().lock();
    if json {
        serde_json::to_writer_pretty(&mut out, &reviews)?;
        return writeln!(out);
    }
    if reviews.is_empty() {
        return writeln!(
            out,
            "No reviews yet. Record a defect and create a review in Lens."
        );
    }
    // Titles come from web pages: no control characters reach the terminal.
    let plain = |text: &str| text.chars().filter(|c| !c.is_control()).collect::<String>();
    for r in reviews {
        let when = crate::repro::iso_time(r.created_at);
        let task = r
            .vibeq_task_url
            .map(|u| format!("  {}", plain(&u)))
            .unwrap_or_default();
        writeln!(
            out,
            "{:>5}  {}  {}{task}",
            r.id,
            &when[..16.min(when.len())],
            plain(&r.title)
        )?;
    }
    Ok(())
}

/// `lens review <id>`: what `get_review` returns over MCP, as JSON.
pub fn show(paths: &Paths, id: &str) -> io::Result<()> {
    let mut client = Client::connect(paths)?;
    let found = review(&mut client, id)?;
    let mut value = crate::mcp::review_json(&found);
    value["untrusted"] = format!(
        "Fields under untrustedPageContent, and the title, are {}",
        crate::mcp::UNTRUSTED
    )
    .into();
    let mut out = io::stdout().lock();
    serde_json::to_writer_pretty(&mut out, &value)?;
    writeln!(out)
}

/// `lens export <id> [--to DIR]`: the review as a folder (report.md, screenshots, evidence, the
/// Playwright test, the HAR, the replay). Prints the folder.
pub fn export(paths: &Paths, id: &str, to: Option<&str>) -> io::Result<()> {
    let mut client = Client::connect(paths)?;
    let found = review(&mut client, id)?;
    let root = match to {
        Some(dir) => PathBuf::from(dir),
        None => paths.data.join("exports"),
    };
    let blobs = crate::blobs::Blobs::new(paths.blobs());
    let folder = crate::export::export(&found, &blobs, &root)?;
    println!("{}", folder.display());
    Ok(())
}

/// `lens export <id> --playwright [--to DIR] [--base-url URL]`: each capture's test, ready for the
/// project (default folder tests/lens), with its HAR. Prints the files.
pub fn playwright(
    paths: &Paths,
    id: &str,
    to: Option<&str>,
    base_url: Option<&str>,
) -> io::Result<()> {
    let mut client = Client::connect(paths)?;
    let found = review(&mut client, id)?;
    let folder = PathBuf::from(to.unwrap_or("tests/lens"));
    std::fs::create_dir_all(&folder)?;
    let blobs = crate::blobs::Blobs::new(paths.blobs());
    let mut wrote = 0;
    for (index, item) in found.items.iter().enumerate() {
        let n = index + 1;
        let Some(evidence) = crate::repro::parse(&blobs.read_all(&item.evidence.sha256)?) else {
            continue;
        };
        let name = format!("lens-review-{}-capture-{n}", found.id);
        let (spec, har) = crate::export::project_test(&found, item, n, &evidence, base_url, &name);
        let file = folder.join(format!("{name}.spec.ts"));
        std::fs::write(&file, spec)?;
        println!("{}", file.display());
        if let Some(har) = har {
            let file = folder.join(format!("{name}.har"));
            std::fs::write(&file, har)?;
            println!("{}", file.display());
        }
        wrote += 1;
    }
    if wrote == 0 {
        return Err(io::Error::other(
            "this review has no recorded steps to repeat",
        ));
    }
    Ok(())
}

/// `lens recent [site]`: the last ten minutes the browsers hold for a site, as JSON.
pub fn recent(paths: &Paths, site: Option<&str>) -> io::Result<()> {
    let mut client = Client::connect(paths)?;
    let site = site.map(crate::mcp::host);
    let Reply::LiveEvidence(tabs) = ask(&mut client, Request::RecentEvidence { site })? else {
        return Err(io::Error::other("unexpected reply"));
    };
    let value = serde_json::json!({
        "untrusted": format!("Everything in tabs is {}", crate::mcp::UNTRUSTED),
        "tabs": tabs,
    });
    let mut out = io::stdout().lock();
    serde_json::to_writer_pretty(&mut out, &value)?;
    writeln!(out)
}

/// `lens verify <id> --base-url URL [--capture N] [--project DIR]`: repeats the steps on the dev
/// server with the project's Playwright and says whether the recorded failures happen again.
pub fn verify(
    paths: &Paths,
    id: &str,
    base_url: Option<&str>,
    capture: Option<&str>,
    project: Option<&str>,
) -> io::Result<()> {
    let base_url = base_url.ok_or_else(|| {
        io::Error::other(
            "lens verify <id> --base-url http://localhost:3000 [--capture N] [--project DIR]",
        )
    })?;
    let mut client = Client::connect(paths)?;
    let found = review(&mut client, id)?;
    let n: usize = capture
        .map_or(Ok(1), str::parse)
        .map_err(|_| io::Error::other("--capture takes a number"))?;
    let item = found
        .items
        .get(n.wrapping_sub(1))
        .ok_or_else(|| io::Error::other(format!("review {} has no capture {n}", found.id)))?;
    let bytes = crate::blobs::Blobs::new(paths.blobs()).read_all(&item.evidence.sha256)?;
    let evidence = crate::repro::parse(&bytes)
        .ok_or_else(|| io::Error::other("Lens recorded no steps for this capture"))?;
    let raw: serde_json::Value = serde_json::from_slice(&bytes)?;
    let project = PathBuf::from(project.unwrap_or("."));
    let verdict = crate::verify::verify(&found, item, n, &evidence, &raw, base_url, &project)
        .map_err(io::Error::other)?;
    let mut out = io::stdout().lock();
    serde_json::to_writer_pretty(&mut out, &verdict)?;
    writeln!(out)?;
    // A script or CI job reads the exit status: the fix is proven only when the steps ran and no
    // recorded failure came back.
    let still = verdict["stillFailing"]
        .as_array()
        .is_some_and(|a| !a.is_empty());
    if verdict["stepsRan"] != true || still {
        drop(out);
        std::process::exit(1);
    }
    Ok(())
}

/// `lens agents connect|disconnect`.
pub fn agents(action: Option<&str>) -> io::Result<()> {
    let done = match action {
        Some("connect") => crate::agents::connect(&crate::paths::executable()?),
        Some("disconnect") => crate::agents::disconnect(),
        _ => {
            return Err(io::Error::other(
                "lens agents connect|disconnect (the sirv-lens skill and MCP server)",
            ));
        }
    };
    let mut failed = false;
    for setup in &done {
        failed |= !setup.ok;
        println!(
            "{:<18} {}{}",
            setup.agent,
            if setup.ok { "" } else { "failed: " },
            setup.detail
        );
    }
    if failed {
        return Err(io::Error::other("some agents were not set up"));
    }
    Ok(())
}
