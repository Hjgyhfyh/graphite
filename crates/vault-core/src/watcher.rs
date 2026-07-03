//! Наблюдение за vault (SPEC §6.10, Р12): notify (ReadDirectoryChangesW) +
//! notify-debouncer-full с дебаунсом 300 мс, stability-check двумя чтениями
//! с равным blake3 через интервал, эхо-подавление собственных записей и
//! классификация created / modified / removed / moved (матч «пропал A,
//! появился B» по `id` из frontmatter, SPEC §6.11).

use std::collections::{BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{
    new_debouncer, DebounceEventResult, DebouncedEvent, Debouncer, RecommendedCache,
};

use crate::error::VaultError;
use crate::model::{NoteId, Rev};

pub const DEBOUNCE_MS: u64 = 300;

const WORKER_TICK_MS: u64 = 50;
const STABILITY_INTERVAL_MS: u64 = 60;
const STABILITY_MAX_ROUNDS: u32 = 50;
const MOVE_MATCH_GRACE_MS: u64 = 500;

/// Консультация эхо-набора писателя (SPEC §6.10): сверка `(rel_path, blake3-64hex)`
/// после стабилизации; попадание изымается из набора и подавляет событие.
/// Сигнатура повторяет `writer::EchoSet::take`.
pub trait EchoSource: Send + Sync {
    fn take(&self, rel_path: &str, full_hash: &str) -> bool;
}

impl EchoSource for crate::writer::EchoSet {
    fn take(&self, rel_path: &str, full_hash: &str) -> bool {
        crate::writer::EchoSet::take(self, rel_path, full_hash)
    }
}

/// Пустой эхо-набор: ни одна запись не считается своей.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoEcho;

impl EchoSource for NoEcho {
    fn take(&self, _rel_path: &str, _full_hash: &str) -> bool {
        false
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchEventKind {
    Created,
    Modified,
    Removed,
    Moved { from: String },
}

/// Событие подписчику: путь от корня vault с `/`-разделителями; `rev` — первые
/// 16 hex того же blake3, что использован в stability-check (нет у `Removed`).
#[derive(Debug, Clone, PartialEq)]
pub struct WatchEvent {
    pub path: String,
    pub kind: WatchEventKind,
    pub note_id: Option<NoteId>,
    pub rev: Option<Rev>,
}

pub struct VaultWatcher {
    debouncer: Option<Debouncer<RecommendedWatcher, RecommendedCache>>,
    worker: Option<JoinHandle<()>>,
}

impl VaultWatcher {
    pub fn stop(mut self) -> Result<(), VaultError> {
        self.shutdown();
        Ok(())
    }

    fn shutdown(&mut self) {
        if let Some(debouncer) = self.debouncer.take() {
            debouncer.stop();
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for VaultWatcher {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn start<F>(
    vault_root: &Path,
    echo: Arc<dyn EchoSource>,
    on_change: F,
) -> Result<VaultWatcher, VaultError>
where
    F: FnMut(Vec<WatchEvent>) + Send + 'static,
{
    let root = std::fs::canonicalize(vault_root)?;
    let (tx, rx) = mpsc::channel::<DebounceEventResult>();
    let mut debouncer = new_debouncer(Duration::from_millis(DEBOUNCE_MS), None, tx)
        .map_err(|e| VaultError::Unavailable(format!("watcher init: {e}")))?;
    debouncer
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| VaultError::Unavailable(format!("watcher watch: {e}")))?;
    let ids = scan_ids(&root);
    let worker = Worker {
        root,
        echo,
        on_change: Box::new(on_change),
        ids,
        last_seen: HashMap::new(),
        pending_removed: Vec::new(),
    };
    let handle = thread::Builder::new()
        .name("graphite-vault-watcher".into())
        .spawn(move || worker.run(rx))?;
    Ok(VaultWatcher {
        debouncer: Some(debouncer),
        worker: Some(handle),
    })
}

/// Полный blake3 содержимого, 64 hex-символа в нижнем регистре — формат,
/// в котором watcher сверяется с эхо-набором писателя.
pub fn full_hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

fn rev_of(full_hash: &str) -> Rev {
    Rev(full_hash[..16].to_string())
}

struct PendingRemoved {
    rel: String,
    id: Option<String>,
    deadline: Instant,
}

enum FileState {
    Present { hash: String, id: Option<String> },
    Absent,
    Busy,
}

struct Worker {
    root: PathBuf,
    echo: Arc<dyn EchoSource>,
    on_change: Box<dyn FnMut(Vec<WatchEvent>) + Send>,
    ids: HashMap<String, Option<String>>,
    last_seen: HashMap<String, String>,
    pending_removed: Vec<PendingRemoved>,
}

impl Worker {
    fn run(mut self, rx: mpsc::Receiver<DebounceEventResult>) {
        loop {
            match rx.recv_timeout(Duration::from_millis(WORKER_TICK_MS)) {
                Ok(Ok(batch)) => self.process_batch(batch),
                Ok(Err(_)) => {}
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            self.flush_due_removed();
        }
    }

    fn process_batch(&mut self, batch: Vec<DebouncedEvent>) {
        let mut renames: Vec<(String, String)> = Vec::new();
        let mut touched: BTreeSet<String> = BTreeSet::new();

        for ev in &batch {
            let stitched_rename =
                matches!(ev.kind, EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                    && ev.paths.len() == 2;
            if stitched_rename {
                let from = rel_of(&self.root, &ev.paths[0]);
                let to = rel_of(&self.root, &ev.paths[1]);
                match (from, to) {
                    (Some(f), Some(t)) => renames.push((f, t)),
                    (Some(f), None) => {
                        touched.insert(f);
                    }
                    (None, Some(t)) => {
                        touched.insert(t);
                    }
                    (None, None) => {}
                }
            } else {
                for path in &ev.paths {
                    if let Some(rel) = rel_of(&self.root, path) {
                        touched.insert(rel);
                    }
                }
            }
        }
        for (from, to) in &renames {
            touched.remove(from);
            touched.remove(to);
        }
        if renames.is_empty() && touched.is_empty() {
            return;
        }

        let mut probe = touched.clone();
        for (_, to) in &renames {
            probe.insert(to.clone());
        }
        let states = stabilize(&self.root, &probe);

        for (rel, state) in &states {
            if matches!(state, FileState::Present { .. }) {
                self.pending_removed.retain(|p| &p.rel != rel);
            }
        }

        let mut out: Vec<WatchEvent> = Vec::new();
        let mut removed: Vec<(String, Option<String>)> = Vec::new();
        let mut created: Vec<(String, String, Option<String>)> = Vec::new();

        for (from, to) in renames {
            match states.get(&to) {
                Some(FileState::Present { hash, id }) => {
                    let prior = self.ids.remove(&from).flatten();
                    self.last_seen.remove(&from);
                    let id = id.clone().or(prior);
                    let hash = hash.clone();
                    self.note_seen(&to, id.clone(), &hash);
                    if self.echo.take(&to, &hash) {
                        continue;
                    }
                    out.push(WatchEvent {
                        path: to,
                        kind: WatchEventKind::Moved { from },
                        note_id: id.map(NoteId),
                        rev: Some(rev_of(&hash)),
                    });
                }
                _ => {
                    if let Some(id) = self.ids.get(&from) {
                        removed.push((from.clone(), id.clone()));
                    }
                }
            }
        }

        for rel in touched {
            match states.get(&rel) {
                Some(FileState::Present { hash, id }) => {
                    if self.ids.contains_key(&rel) {
                        if self.last_seen.get(&rel) == Some(hash) {
                            self.ids.insert(rel, id.clone());
                            continue;
                        }
                        let hash = hash.clone();
                        self.note_seen(&rel, id.clone(), &hash);
                        if self.echo.take(&rel, &hash) {
                            continue;
                        }
                        out.push(WatchEvent {
                            path: rel,
                            kind: WatchEventKind::Modified,
                            note_id: id.clone().map(NoteId),
                            rev: Some(rev_of(&hash)),
                        });
                    } else {
                        created.push((rel, hash.clone(), id.clone()));
                    }
                }
                Some(FileState::Absent) => {
                    if let Some(id) = self.ids.get(&rel) {
                        removed.push((rel.clone(), id.clone()));
                    }
                }
                _ => {}
            }
        }

        let deadline = Instant::now() + Duration::from_millis(MOVE_MATCH_GRACE_MS);
        for (rel, id) in removed {
            self.pending_removed.push(PendingRemoved { rel, id, deadline });
        }

        for (rel, hash, id) in created {
            let matched = id.as_ref().and_then(|created_id| {
                self.pending_removed
                    .iter()
                    .position(|p| p.id.as_deref() == Some(created_id.as_str()))
            });
            self.note_seen(&rel, id.clone(), &hash);
            let kind = match matched {
                Some(idx) => {
                    let gone = self.pending_removed.remove(idx);
                    self.ids.remove(&gone.rel);
                    self.last_seen.remove(&gone.rel);
                    WatchEventKind::Moved { from: gone.rel }
                }
                None => WatchEventKind::Created,
            };
            if self.echo.take(&rel, &hash) {
                continue;
            }
            out.push(WatchEvent {
                path: rel,
                kind,
                note_id: id.map(NoteId),
                rev: Some(rev_of(&hash)),
            });
        }

        if !out.is_empty() {
            (self.on_change)(out);
        }
    }

    fn flush_due_removed(&mut self) {
        if self.pending_removed.is_empty() {
            return;
        }
        let now = Instant::now();
        let mut out = Vec::new();
        let mut keep = Vec::new();
        for pending in self.pending_removed.drain(..) {
            if pending.deadline <= now {
                self.ids.remove(&pending.rel);
                self.last_seen.remove(&pending.rel);
                out.push(WatchEvent {
                    path: pending.rel,
                    kind: WatchEventKind::Removed,
                    note_id: pending.id.map(NoteId),
                    rev: None,
                });
            } else {
                keep.push(pending);
            }
        }
        self.pending_removed = keep;
        if !out.is_empty() {
            (self.on_change)(out);
        }
    }

    fn note_seen(&mut self, rel: &str, id: Option<String>, hash: &str) {
        self.ids.insert(rel.to_string(), id);
        self.last_seen.insert(rel.to_string(), hash.to_string());
    }
}

fn stabilize(root: &Path, rels: &BTreeSet<String>) -> HashMap<String, FileState> {
    let mut prev = read_states(root, rels);
    if rels.is_empty() {
        return prev;
    }
    for _ in 0..STABILITY_MAX_ROUNDS {
        thread::sleep(Duration::from_millis(STABILITY_INTERVAL_MS));
        let cur = read_states(root, rels);
        let settled = rels
            .iter()
            .all(|rel| same_state(prev.get(rel), cur.get(rel)));
        prev = cur;
        if settled {
            break;
        }
    }
    prev
}

fn read_states(root: &Path, rels: &BTreeSet<String>) -> HashMap<String, FileState> {
    rels.iter()
        .map(|rel| (rel.clone(), read_state(&abs_of(root, rel))))
        .collect()
}

fn abs_of(root: &Path, rel: &str) -> PathBuf {
    let mut abs = root.to_path_buf();
    for comp in rel.split('/') {
        abs.push(comp);
    }
    abs
}

fn same_state(a: Option<&FileState>, b: Option<&FileState>) -> bool {
    match (a, b) {
        (
            Some(FileState::Present { hash: h1, .. }),
            Some(FileState::Present { hash: h2, .. }),
        ) => h1 == h2,
        (Some(FileState::Absent), Some(FileState::Absent)) => true,
        _ => false,
    }
}

fn read_state(abs: &Path) -> FileState {
    match std::fs::metadata(abs) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return FileState::Absent,
        Err(_) => return FileState::Busy,
        Ok(meta) if !meta.is_file() => return FileState::Absent,
        Ok(_) => {}
    }
    match std::fs::read(abs) {
        Ok(bytes) => FileState::Present {
            hash: full_hash(&bytes),
            id: extract_id(&bytes),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => FileState::Absent,
        Err(_) => FileState::Busy,
    }
}

fn rel_of(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let mut comps: Vec<String> = Vec::new();
    for comp in rel.components() {
        match comp {
            Component::Normal(os) => comps.push(os.to_string_lossy().into_owned()),
            _ => return None,
        }
    }
    if comps.is_empty() {
        return None;
    }
    for comp in &comps {
        if is_ignored_component(comp) {
            return None;
        }
    }
    let name = comps.last().expect("непустой список компонентов");
    let lower = name.to_ascii_lowercase();
    if lower.contains(".tmp") || !lower.ends_with(".md") {
        return None;
    }
    Some(comps.join("/"))
}

fn is_ignored_component(comp: &str) -> bool {
    comp.starts_with('.') || comp.starts_with('~') || comp.eq_ignore_ascii_case("target")
}

fn extract_id(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let text: &str = text.as_ref();
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.split('\n');
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    for line in lines {
        let trimmed = line.trim_end();
        if trimmed == "---" || trimmed == "..." {
            break;
        }
        if let Some(rest) = trimmed.strip_prefix("id:") {
            let value = rest.trim().trim_matches('"').trim_matches('\'');
            if value.len() == 26 && value.bytes().all(|b| b.is_ascii_alphanumeric()) {
                return Some(value.to_ascii_uppercase());
            }
            return None;
        }
    }
    None
}

fn scan_ids(root: &Path) -> HashMap<String, Option<String>> {
    let mut map = HashMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if file_type.is_dir() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !is_ignored_component(&name) {
                    stack.push(path);
                }
            } else if file_type.is_file() {
                if let Some(rel) = rel_of(root, &path) {
                    let id = std::fs::read(&path).ok().and_then(|b| extract_id(&b));
                    map.insert(rel, id);
                }
            }
        }
    }
    map
}
