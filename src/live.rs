//! Live evidence for coding agents: the last ten minutes on the sites Lens collects on, without a
//! recording. An agent asks the daemon; the extension, which keeps one request waiting while the
//! person allows it in Settings, answers with its buffer; the daemon turns that into findings and
//! a timeline. Nothing is stored.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use ts_rs::TS;

/// How long a browser waits for a question before it asks again.
const POLL: Duration = Duration::from_secs(20);
/// How long an agent waits for the browsers, and for more of them once one answered.
const ANSWER: Duration = Duration::from_secs(6);
const MORE: Duration = Duration::from_millis(1500);
/// The newest timeline lines an agent gets per tab.
const TIMELINE_LINES: usize = 200;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Ask {
    #[ts(type = "number")]
    pub id: u64,
    /// A host such as app.example.com; every collected tab when None.
    pub site: Option<String>,
}

/// One collected tab's buffer, as the extension sends it: the same evidence as a capture, without
/// the screenshot, the shots and the replay.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LiveTab {
    pub url: String,
    pub title: String,
    pub evidence: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LiveDigest {
    pub url: String,
    pub title: String,
    /// Failed requests, console errors and exceptions.
    pub findings: Vec<String>,
    /// The newest steps, requests and console lines, oldest first.
    pub timeline: String,
}

#[derive(Default)]
struct State {
    next: u64,
    /// The questions agents wait on, oldest first: two agents can ask at once.
    open: Vec<Ask>,
    answers: HashMap<u64, Vec<LiveTab>>,
}

#[derive(Default)]
pub struct Asks {
    state: Mutex<State>,
    changed: Condvar,
}

impl Asks {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// A browser waits here for the next question after `after`; None when none came.
    pub fn wait_for_ask(&self, after: u64) -> Option<Ask> {
        let deadline = Instant::now() + POLL;
        let mut state = self.lock();
        loop {
            if let Some(ask) = state.open.iter().find(|a| a.id > after) {
                return Some(ask.clone());
            }
            let left = deadline.checked_duration_since(Instant::now())?;
            state = self
                .changed
                .wait_timeout(state, left)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
    }

    /// A browser's answer. Late answers, after the agent stopped waiting, are dropped.
    pub fn answer(&self, ask: u64, tabs: Vec<LiveTab>) {
        let mut state = self.lock();
        if state.open.iter().any(|a| a.id == ask) {
            state.answers.entry(ask).or_default().extend(tabs);
            self.changed.notify_all();
        }
    }

    /// An agent's question: what every browser that answers in time holds for `site`.
    pub fn ask(&self, site: Option<String>) -> Option<Vec<LiveTab>> {
        let mut state = self.lock();
        state.next += 1;
        let id = state.next;
        state.open.push(Ask { id, site });
        self.changed.notify_all();
        let deadline = Instant::now() + ANSWER;
        let mut answered_by: Option<Instant> = None;
        loop {
            if state.answers.contains_key(&id) && answered_by.is_none() {
                answered_by = Some(Instant::now() + MORE);
            }
            let until = answered_by.map_or(deadline, |more| more.min(deadline));
            let Some(left) = until.checked_duration_since(Instant::now()) else {
                break;
            };
            state = self
                .changed
                .wait_timeout(state, left)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
        state.open.retain(|a| a.id != id);
        state.answers.remove(&id)
    }
}

/// What a tab's buffer shows: its findings and the end of its timeline.
pub fn digest(tab: LiveTab) -> LiveDigest {
    let findings = crate::export::findings(&tab.evidence);
    let timeline = serde_json::to_vec(&tab.evidence)
        .ok()
        .and_then(|bytes| crate::repro::parse(&bytes))
        .map(|evidence| {
            let context = crate::repro::Context {
                voice: &[],
                notes: &[],
                screen: &[],
                pointing: &[],
                kept: &[],
            };
            let full = crate::repro::timeline(&evidence, &context);
            let lines: Vec<&str> = full.lines().collect();
            lines[lines.len().saturating_sub(TIMELINE_LINES)..].join("\n")
        })
        .unwrap_or_default();
    LiveDigest {
        url: tab.url,
        title: tab.title,
        findings,
        timeline,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn a_question_reaches_a_waiting_browser_and_comes_back_with_its_answer() {
        let asks = Arc::new(Asks::default());
        let browser = {
            let asks = asks.clone();
            std::thread::spawn(move || {
                let ask = asks.wait_for_ask(0).expect("a question");
                assert_eq!(ask.site.as_deref(), Some("app.example.com"));
                asks.answer(
                    ask.id,
                    vec![LiveTab {
                        url: "https://app.example.com/cart".into(),
                        title: "Cart".into(),
                        evidence: serde_json::json!({ "events": [] }),
                    }],
                );
                ask.id
            })
        };
        let tabs = asks.ask(Some("app.example.com".into())).expect("an answer");
        assert_eq!(tabs.len(), 1);
        let id = browser.join().unwrap();
        // The question is closed: a late answer is dropped, and nobody gets it again.
        asks.answer(id, vec![]);
        assert!(asks.lock().answers.is_empty());
        assert!(asks.lock().open.is_empty());
    }

    #[test]
    fn two_agents_asking_at_once_both_get_an_answer() {
        let asks = Arc::new(Asks::default());
        let agents: Vec<_> = ["a.example.com", "b.example.com"]
            .into_iter()
            .map(|site| {
                let asks = asks.clone();
                std::thread::spawn(move || asks.ask(Some(site.into())))
            })
            .collect();
        // The browser answers each question in turn, as it polls after the last one it saw.
        let mut after = 0;
        for _ in 0..2 {
            let ask = asks.wait_for_ask(after).expect("a question");
            asks.answer(
                ask.id,
                vec![LiveTab {
                    url: format!("https://{}/", ask.site.clone().unwrap()),
                    title: String::new(),
                    evidence: serde_json::json!({}),
                }],
            );
            after = ask.id;
        }
        for agent in agents {
            assert_eq!(agent.join().unwrap().expect("an answer").len(), 1);
        }
        assert!(asks.lock().open.is_empty());
    }
}
