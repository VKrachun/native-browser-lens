use super::capture::*;
use super::*;

#[test]
fn issue_times_become_trims_around_the_transcript() {
    let capture = Capture {
        id: 3,
        observation: 1,
        created_at: 60_000,
        page_url: String::new(),
        page_title: String::new(),
        mode: CaptureMode::Deep,
        screenshot: BlobRef {
            sha256: "a".repeat(64),
            size: 1,
            media_type: String::new(),
        },
        evidence: BlobRef {
            sha256: "b".repeat(64),
            size: 1,
            media_type: String::new(),
        },
        event_count: 0,
        gap_count: 0,
        annotations: vec![],
        recording: None,
        kind: CaptureKind::Session,
        started_at: 10_000,
        edits: Edits::default(),
        shots: vec![],
    };
    let issue = |from, to| investigate::Issue {
        title: "x".into(),
        findings: vec![],
        tags: vec![],
        from_seconds: from,
        to_seconds: to,
    };
    let edits = issue_edits(
        &issue(Some(20.0), Some(5.0)),
        Some(10_000),
        std::slice::from_ref(&capture),
    )
    .0;
    assert_eq!(edits.len(), 1);
    assert_eq!(
        (edits[0].1.trim_start, edits[0].1.trim_end),
        (Some(12_000), Some(33_000))
    );
    assert_eq!(
        issue_edits(
            &issue(None, Some(5.0)),
            Some(10_000),
            std::slice::from_ref(&capture)
        ),
        Default::default()
    );
    // Far outside every capture: the times are wrong, so all stay whole.
    assert_eq!(
        issue_edits(
            &issue(Some(500.0), Some(600.0)),
            Some(10_000),
            std::slice::from_ref(&capture)
        ),
        Default::default()
    );
    // Another issue's recording stays out of this issue's task.
    let mut later = capture.clone();
    later.id = 2;
    later.started_at = 900_000;
    later.created_at = 960_000;
    let (edits, leave) = issue_edits(
        &issue(Some(20.0), Some(5.0)),
        Some(10_000),
        &[capture, later],
    );
    assert_eq!((edits.len(), leave), (1, vec![2]));
}

#[test]
fn a_page_of_long_urls_ends_before_the_reply_limit() {
    let summary = |id| crate::protocol::ReviewSummary {
        id,
        observation: 1,
        revision: 1,
        created_at: 0,
        page_url: Some(format!("https://a.test/{}", "x".repeat(11 * 1024))),
        title: String::new(),
        captures: 1,
        vibeq_task_id: None,
        vibeq_task_url: None,
    };
    let mut page: Vec<_> = (1..=100).rev().map(summary).collect();
    fit_page(&mut page);
    let bytes = serde_json::to_vec(&page).unwrap().len();
    assert!(
        !page.is_empty() && page.len() < 100 && bytes < MAX_REPLY_BYTES,
        "{bytes}"
    );
    let mut one = vec![summary(1)];
    fit_page(&mut one);
    assert_eq!(one.len(), 1);
}

fn daemon() -> (tempfile::TempDir, Daemon) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("lens.sqlite")).unwrap();
    let paths = Paths {
        data: dir.path().to_path_buf(),
        runtime: dir.path().join("run"),
        logs: dir.path().join("logs"),
    };
    let daemon = Daemon::new(store, &paths);
    (dir, daemon)
}

fn ask(daemon: &Daemon, json: &str) -> serde_json::Value {
    serde_json::from_slice(&daemon.answer(json.as_bytes(), &Transfers::default()).0).unwrap()
}

#[test]
fn invalid_settings_and_browser_migration_preserve_the_saved_default_after_restart() {
    let (dir, daemon) = daemon();
    let send = |tracker: &str, address: &str, only_if_unset: bool| {
        let request = serde_json::json!({"id": 1, "method": "setDestination", "params": {
            "choice": {"tracker": tracker, "address": address}, "onlyIfUnset": only_if_unset
        }});
        ask(&daemon, &request.to_string())
    };
    assert_eq!(
        send("jira", "https://team.atlassian.net", false)["status"],
        "ok"
    );
    assert_eq!(send("github", "invalid", false)["status"], "error");
    assert_eq!(
        send("linear", "", true)["result"]["data"]["choice"]["tracker"],
        "jira"
    );
    let paths = daemon.paths.clone();
    drop(daemon);
    let restarted = Daemon::new(
        Store::open(&dir.path().join("lens.sqlite")).unwrap(),
        &paths,
    );
    let settings = ask(&restarted, r#"{"id":2,"method":"getDestination"}"#);
    assert_eq!(
        settings["result"]["data"]["choice"]["address"],
        "https://team.atlassian.net"
    );
}

#[test]
fn a_slow_request_does_not_hold_up_the_next_one_on_its_connection() {
    let (_dir, daemon) = daemon();
    let paths = daemon.paths.clone();
    paths.ensure().unwrap();
    let listener = ipc::listen(&paths).unwrap();
    let daemon = Arc::new(daemon);
    std::thread::spawn(move || {
        let stream = listener.accept().unwrap();
        let _ = serve(daemon, stream);
    });
    let mut client = ipc::connect(&paths).unwrap();
    // The long poll waits for an agent's ask that never comes; hello comes back meanwhile.
    write_frame(
        &mut client,
        br#"{"id":1,"method":"waitForAsk","params":{"after":0}}"#,
    )
    .unwrap();
    write_frame(&mut client, br#"{"id":2,"method":"hello"}"#).unwrap();
    let first = read_frame(&mut client, MAX_REPLY_BYTES).unwrap().unwrap();
    let reply: serde_json::Value = serde_json::from_slice(&first).unwrap();
    assert_eq!(reply["id"], 2, "{reply}");
    assert_eq!(reply["status"], "ok");
}

#[test]
fn answers_requests_and_reports_bad_ones() {
    let (_dir, daemon) = daemon();
    let created = ask(
        &daemon,
        r#"{"id":7,"method":"createObservation","params":{"title":" Cart total ","url":null}}"#,
    );
    assert_eq!(created["id"], 7);
    assert_eq!(created["status"], "ok");
    assert_eq!(created["result"]["data"]["title"], "Cart total");

    let listed = ask(&daemon, r#"{"id":8,"method":"listObservations"}"#);
    assert_eq!(listed["result"]["data"].as_array().unwrap().len(), 1);

    let empty = ask(
        &daemon,
        r#"{"id":9,"method":"createObservation","params":{"title":"  ","url":null}}"#,
    );
    assert_eq!(empty["error"]["code"], "badRequest");

    let unknown = ask(&daemon, r#"{"id":10,"method":"dropTables"}"#);
    assert_eq!(
        (unknown["id"].as_u64(), unknown["status"].as_str()),
        (Some(10), Some("error"))
    );

    assert!(
        daemon
            .answer(br#"{"id":11,"method":"shutdown"}"#, &Transfers::default())
            .1
    );
    assert!(
        !daemon
            .answer(br#"{"id":12,"method":"hello"}"#, &Transfers::default())
            .1
    );
}

#[test]
fn normalizes_origins_and_refuses_anything_else() {
    assert_eq!(
        normalize_origin(" https://Shop.Example.com:443/ ").unwrap(),
        "https://shop.example.com"
    );
    assert_eq!(
        normalize_origin("http://127.0.0.1:8080").unwrap(),
        "http://127.0.0.1:8080"
    );
    for bad in [
        "shop.example.com",
        "https://a.test/cart",
        "https://a.test/?q=1",
        "https://u:p@a.test",
        "file:///etc",
        "chrome://settings",
    ] {
        assert!(normalize_origin(bad).is_err(), "{bad} was accepted");
    }
}

#[test]
fn a_recording_without_a_screenshot_or_a_replay_is_still_saved() {
    // Firefox without access to all sites, on a page the recorder did not reach.
    let (_dir, daemon) = daemon();
    let reply = ask(
        &daemon,
        &serde_json::json!({ "id": 1, "method": "createCapture", "params": {
            "observation": null, "pageUrl": "https://shop.test/", "pageTitle": "Cart",
            "renderScreenshot": true,
            "evidence": { "mode": "limited", "page": null, "events": [], "actions": [],
                "gaps": [{ "channel": "screenshot", "reason": "No screenshot", "startedAt": 1, "endedAt": null }] },
            "recording": null, "kind": "session", "startedAt": 1
        } })
        .to_string(),
    );
    assert_eq!(reply["status"], "ok", "{reply}");
    let sha = reply["result"]["data"]["screenshot"]["sha256"]
        .as_str()
        .unwrap();
    assert_eq!(daemon.blobs.read_all(sha).unwrap(), PENDING_SCREENSHOT);
}

#[test]
fn a_capture_without_a_screenshot_gets_one_from_its_replay() {
    let (_dir, daemon) = daemon();
    let at = 1_700_000_000_000_i64;
    let events = serde_json::json!([
        { "type": 4, "data": { "href": "https://shop.test/", "width": 800, "height": 600 }, "timestamp": at },
        { "type": 2, "timestamp": at + 1, "data": { "initialOffset": { "left": 0, "top": 0 },
          "node": { "type": 0, "id": 1, "childNodes": [
            { "type": 1, "id": 2, "name": "html", "publicId": "", "systemId": "" },
            { "type": 2, "id": 3, "tagName": "html", "attributes": {}, "childNodes": [
              { "type": 2, "id": 4, "tagName": "head", "attributes": {}, "childNodes": [] },
              { "type": 2, "id": 5, "tagName": "body", "attributes": {}, "childNodes": [
                { "type": 3, "id": 6, "textContent": "Cart" }] }] }] } } },
        { "type": 5, "data": { "tag": "lens-end", "payload": {} }, "timestamp": at + 3000 }
    ]);
    let recording = daemon
        .blobs
        .put(events.to_string().as_bytes(), "application/json")
        .unwrap();
    let click = |t: i64| {
        serde_json::json!({ "kind": "click", "timestamp": t, "url": "https://shop.test/",
            "target": null, "value": null, "masked": false })
    };
    let request = |id: u32| {
        serde_json::json!({ "id": id, "method": "createCapture", "params": {
            "observation": null, "pageUrl": "https://shop.test/", "pageTitle": "Cart",
            "renderScreenshot": true,
            "evidence": { "mode": "limited", "page": null, "gaps": [], "events": [],
                "actions": [click(at + 100), click(at + 1500)] },
            "recording": recording, "kind": "session", "startedAt": at
        } })
        .to_string()
    };
    // Without the replay tools: a picture that says so, and a mark to render it later.
    let reply = ask(&daemon, &request(1));
    assert_eq!(reply["status"], "ok", "{reply}");
    let capture = &reply["result"]["data"];
    let sha = capture["screenshot"]["sha256"].as_str().unwrap();
    assert_eq!(daemon.blobs.read_all(sha).unwrap(), PENDING_SCREENSHOT);
    let id = capture["id"].as_i64().unwrap();
    assert!(
        daemon
            .lock_store()
            .setting(&pending_pictures(id))
            .unwrap()
            .is_some()
    );
    // With them (the e2e tools, when this computer has them): the replay's own pictures.
    let tools = std::env::var_os("LENS_E2E_VIDEO_TOOLS")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            directories::BaseDirs::new().map(|b| b.data_dir().join("sirv-lens/video-tools"))
        })
        .filter(|t| crate::attachments::tools_ready(t));
    let Some(tools) = tools else { return };
    // The tools folder is linked into the test's Lens home on Unix only.
    if cfg!(not(unix)) {
        let _ = tools;
        return;
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(&tools, daemon.paths.data.join("video-tools")).unwrap();
    let reply = ask(&daemon, &request(2));
    let capture = &reply["result"]["data"];
    let png = daemon
        .blobs
        .read_all(capture["screenshot"]["sha256"].as_str().unwrap())
        .unwrap();
    assert!(
        png.starts_with(b"\x89PNG") && png != PENDING_SCREENSHOT,
        "{reply}"
    );
    assert_eq!(
        capture["shots"].as_array().map(Vec::len),
        Some(2),
        "{reply}"
    );
}

#[test]
fn step_shots_follow_a_series_of_steps() {
    let action = |kind: ActionKind, timestamp: i64| Action {
        kind,
        timestamp,
        url: "https://shop.test/".into(),
        target: None,
        value: None,
        masked: false,
    };
    let actions = [
        action(ActionKind::Click, 1000),
        action(ActionKind::Fill, 1200),
        action(ActionKind::Press, 1500),
        action(ActionKind::Click, 5000),
    ];
    assert_eq!(step_shot_times(&actions), vec![2200, 5700]);
}

#[test]
fn stores_a_capture_and_serves_its_blobs_in_chunks() {
    let (_dir, daemon) = daemon();
    let png = [b"\x89PNG\r\n\x1a\n".as_slice(), &[7u8; 600 * 1024]].concat();
    // The recording arrives first, in chunks, as a blob.
    let events = br#"[{"type":4,"data":{"href":"http://127.0.0.1:4100/cart"},"timestamp":1}]"#;
    let upload = "0b5c4e1e-8d7a-4f0e-9a39-1d2f3c4b5a69";
    let first = ask(&daemon, &serde_json::json!({ "id": 9, "method": "uploadChunk", "params": {
        "upload": upload, "offset": 0, "data": BASE64.encode(&events[..10]), "done": false, "mediaType": "application/json" } }).to_string());
    assert_eq!(first["result"]["data"], serde_json::Value::Null, "{first}");
    let last = ask(&daemon, &serde_json::json!({ "id": 10, "method": "uploadChunk", "params": {
        "upload": upload, "offset": 10, "data": BASE64.encode(&events[10..]), "done": true, "mediaType": "application/json" } }).to_string());
    let recording = last["result"]["data"].clone();
    assert_eq!(recording["size"], events.len(), "{last}");
    let request = serde_json::json!({
        "id": 1, "method": "createCapture", "params": {
            "observation": null, "pageUrl": "http://127.0.0.1:4100/cart", "pageTitle": "Cart",
            "screenshot": BASE64.encode(&png),
            "evidence": { "mode": "deep", "page": null, "gaps": [],
                "events": [{ "timestamp": 1, "kind": "console", "data": { "level": "error" } }] },
            "recording": recording, "kind": "session", "startedAt": 1
        }
    });
    let reply = ask(&daemon, &request.to_string());
    assert_eq!(reply["status"], "ok", "{reply}");
    let capture = &reply["result"]["data"];
    assert_eq!(
        (capture["eventCount"].as_u64(), capture["mode"].as_str()),
        (Some(1), Some("deep"))
    );

    let sha = capture["screenshot"]["sha256"].as_str().unwrap();
    let mut read = Vec::new();
    while read.len() < png.len() {
        let chunk = ask(
            &daemon,
            &serde_json::json!({ "id": 2, "method": "readBlob",
            "params": { "sha256": sha, "offset": read.len(), "length": 1_000_000 } })
            .to_string(),
        );
        let data = BASE64
            .decode(chunk["result"]["data"]["data"].as_str().unwrap())
            .unwrap();
        assert!(data.len() as u32 <= MAX_BLOB_CHUNK && !data.is_empty());
        read.extend(data);
    }
    assert_eq!(read, png);
    // A large screenshot comes as an uploaded blob instead of base64.
    let mut by_blob = request.clone();
    by_blob["params"]["screenshot"] = "".into();
    by_blob["params"]["screenshotBlob"] = capture["screenshot"].clone();
    let again = ask(&daemon, &by_blob.to_string());
    assert_eq!(
        again["result"]["data"]["screenshot"]["sha256"], sha,
        "{again}"
    );
    by_blob["params"]["screenshotBlob"]["sha256"] = "0".repeat(64).into();
    assert_eq!(ask(&daemon, &by_blob.to_string())["status"], "error");

    // Edits: saved, validated, and returned with the capture.
    let id = capture["id"].as_i64().unwrap();
    let edits = serde_json::json!({ "trimStart": 2, "trimEnd": null, "cuts": [{ "from": 5, "to": 6 }],
        "annotations": [{ "id": "n1", "at": 3, "text": "here", "drawing": [[{ "x": 1.0, "y": 2.0 }]], "elements": [] }] });
    let saved = ask(&daemon, &serde_json::json!({ "id": 3, "method": "saveEdits", "params": { "capture": id, "edits": edits } }).to_string());
    assert_eq!(
        saved["result"]["data"]["edits"]["cuts"][0]["from"], 5,
        "{saved}"
    );
    assert_eq!(saved["result"]["data"]["kind"], "session");
    let everything = serde_json::json!({ "trimStart": null, "trimEnd": null, "cuts": [{ "from": 0, "to": i64::MAX }], "annotations": [] });
    let nothing_left = ask(&daemon, &serde_json::json!({ "id": 5, "method": "saveEdits", "params": { "capture": id, "edits": everything } }).to_string());
    assert_eq!(
        nothing_left["status"], "error",
        "a cut of everything must not mean: share all"
    );
    let backwards = serde_json::json!({ "trimStart": null, "trimEnd": null, "cuts": [{ "from": 6, "to": 5 }], "annotations": [] });
    let refused = ask(&daemon, &serde_json::json!({ "id": 4, "method": "saveEdits", "params": { "capture": id, "edits": backwards } }).to_string());
    assert_eq!(refused["status"], "error");

    let not_png = serde_json::json!({ "id": 3, "method": "createCapture", "params": {
        "observation": null, "pageUrl": "http://a.test/", "pageTitle": "", "screenshot": BASE64.encode(b"GIF89a"),
        "evidence": { "mode": "screenshotOnly", "page": null, "gaps": [], "events": [] }, "recording": null,
        "kind": "moment", "startedAt": 0 } });
    assert_eq!(
        ask(&daemon, &not_png.to_string())["error"]["code"],
        "badRequest"
    );
}
