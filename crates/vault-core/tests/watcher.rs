use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use vault_core::watcher::{self, EchoSource, NoEcho, WatchEvent, WatchEventKind};
use vault_core::{NoteId, Rev};

const ID_A: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ID_B: &str = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

static DIR_SEQ: AtomicU32 = AtomicU32::new(0);

struct TempVault {
    root: PathBuf,
}

impl TempVault {
    fn new() -> Self {
        let seq = DIR_SEQ.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "graphite-watcher-{}-{}-{}",
            std::process::id(),
            seq,
            nanos
        ));
        fs::create_dir_all(&root).unwrap();
        Self { root }
    }

    fn abs(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    fn write(&self, rel: &str, content: &str) {
        let path = self.abs(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }
}

impl Drop for TempVault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[derive(Default)]
struct TestEcho(Mutex<HashSet<(String, String)>>);

impl TestEcho {
    fn register(&self, rel_path: &str, full_hash: &str) {
        self.0
            .lock()
            .unwrap()
            .insert((rel_path.to_string(), full_hash.to_string()));
    }
}

impl EchoSource for TestEcho {
    fn take(&self, rel_path: &str, full_hash: &str) -> bool {
        self.0
            .lock()
            .unwrap()
            .remove(&(rel_path.to_string(), full_hash.to_string()))
    }
}

type Events = Arc<Mutex<Vec<WatchEvent>>>;

fn collector() -> (Events, impl FnMut(Vec<WatchEvent>) + Send + 'static) {
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    (events, move |batch: Vec<WatchEvent>| {
        sink.lock().unwrap().extend(batch)
    })
}

fn wait_for<T>(
    events: &Events,
    what: &str,
    pred: impl Fn(&[WatchEvent]) -> Option<T>,
) -> T {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(found) = pred(&events.lock().unwrap()) {
            return found;
        }
        assert!(
            Instant::now() < deadline,
            "не дождались ({what}); события: {:?}",
            events.lock().unwrap()
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn assert_silence(events: &Events, ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
    let got = events.lock().unwrap();
    assert!(got.is_empty(), "ожидалась тишина, получено: {got:?}");
}

fn note(id: &str, body: &str) -> String {
    format!("---\nid: {id}\ntitle: Тест\n---\n{body}\n")
}

fn expected_rev(content: &str) -> Rev {
    Rev(watcher::full_hash(content.as_bytes())[..16].to_string())
}

#[test]
fn external_modify_emits_modified() {
    let tv = TempVault::new();
    tv.write("Заметки/Идея.md", &note(ID_A, "первая версия"));
    let (events, cb) = collector();
    let w = watcher::start(&tv.root, Arc::new(NoEcho), cb).unwrap();

    let updated = note(ID_A, "вторая версия");
    tv.write("Заметки/Идея.md", &updated);

    let ev = wait_for(&events, "modified", |all| {
        all.iter()
            .find(|e| e.path == "Заметки/Идея.md" && e.kind == WatchEventKind::Modified)
            .cloned()
    });
    assert_eq!(ev.rev, Some(expected_rev(&updated)));
    assert_eq!(ev.note_id, Some(NoteId(ID_A.to_string())));

    std::thread::sleep(Duration::from_millis(800));
    let all = events.lock().unwrap().clone();
    assert_eq!(all.len(), 1, "лишние события: {all:?}");
    w.stop().unwrap();
}

#[test]
fn external_create_emits_created() {
    let tv = TempVault::new();
    let (events, cb) = collector();
    let w = watcher::start(&tv.root, Arc::new(NoEcho), cb).unwrap();

    let content = note(ID_B, "свежая заметка");
    tv.write("Новая заметка.md", &content);

    let ev = wait_for(&events, "created", |all| {
        all.iter()
            .find(|e| e.path == "Новая заметка.md" && e.kind == WatchEventKind::Created)
            .cloned()
    });
    assert_eq!(ev.rev, Some(expected_rev(&content)));
    assert_eq!(ev.note_id, Some(NoteId(ID_B.to_string())));

    std::thread::sleep(Duration::from_millis(800));
    assert_eq!(events.lock().unwrap().len(), 1);
    w.stop().unwrap();
}

#[test]
fn own_write_via_echo_is_suppressed() {
    let tv = TempVault::new();
    tv.write("Мой файл.md", &note(ID_A, "база"));
    let echo = Arc::new(TestEcho::default());
    let (events, cb) = collector();
    let w = watcher::start(&tv.root, echo.clone(), cb).unwrap();

    let own = note(ID_A, "своя запись ядра");
    echo.register("Мой файл.md", &watcher::full_hash(own.as_bytes()));
    tv.write("Мой файл.md", &own);

    assert_silence(&events, 2000);

    let external = note(ID_A, "а это уже чужая правка");
    tv.write("Мой файл.md", &external);
    let ev = wait_for(&events, "modified после эха", |all| {
        all.iter()
            .find(|e| e.path == "Мой файл.md" && e.kind == WatchEventKind::Modified)
            .cloned()
    });
    assert_eq!(ev.rev, Some(expected_rev(&external)));
    assert_eq!(events.lock().unwrap().len(), 1);
    w.stop().unwrap();
}

#[test]
fn own_plus_external_splice_in_one_window_emits_event() {
    let tv = TempVault::new();
    tv.write("Склейка.md", &note(ID_A, "база"));
    let echo = Arc::new(TestEcho::default());
    let (events, cb) = collector();
    let w = watcher::start(&tv.root, echo.clone(), cb).unwrap();

    let own = note(ID_A, "своя запись");
    echo.register("Склейка.md", &watcher::full_hash(own.as_bytes()));
    tv.write("Склейка.md", &own);
    let external = note(ID_A, "чужой писатель успел в то же окно");
    tv.write("Склейка.md", &external);

    let ev = wait_for(&events, "modified после склейки", |all| {
        all.iter()
            .find(|e| e.path == "Склейка.md" && e.kind == WatchEventKind::Modified)
            .cloned()
    });
    assert_eq!(ev.rev, Some(expected_rev(&external)));

    std::thread::sleep(Duration::from_millis(800));
    assert_eq!(events.lock().unwrap().len(), 1);
    w.stop().unwrap();
}

#[test]
fn os_rename_emits_moved() {
    let tv = TempVault::new();
    tv.write("Старое имя.md", &note(ID_A, "тело"));
    fs::create_dir_all(tv.abs("Проекты")).unwrap();
    let (events, cb) = collector();
    let w = watcher::start(&tv.root, Arc::new(NoEcho), cb).unwrap();

    fs::rename(tv.abs("Старое имя.md"), tv.abs("Проекты/Новое имя.md")).unwrap();

    let ev = wait_for(&events, "moved", |all| {
        all.iter()
            .find(|e| e.path == "Проекты/Новое имя.md")
            .cloned()
    });
    assert_eq!(
        ev.kind,
        WatchEventKind::Moved {
            from: "Старое имя.md".to_string()
        }
    );
    assert_eq!(ev.note_id, Some(NoteId(ID_A.to_string())));

    std::thread::sleep(Duration::from_millis(1200));
    let all = events.lock().unwrap().clone();
    assert_eq!(all.len(), 1, "rename должен дать одно событие: {all:?}");
    w.stop().unwrap();
}

#[test]
fn delete_and_create_matched_as_moved_by_id() {
    let tv = TempVault::new();
    let content = note(ID_B, "переезжающее содержимое");
    tv.write("Черновик.md", &content);
    let (events, cb) = collector();
    let w = watcher::start(&tv.root, Arc::new(NoEcho), cb).unwrap();

    fs::remove_file(tv.abs("Черновик.md")).unwrap();
    tv.write("Итог.md", &content);

    let ev = wait_for(&events, "moved по id", |all| {
        all.iter().find(|e| e.path == "Итог.md").cloned()
    });
    assert_eq!(
        ev.kind,
        WatchEventKind::Moved {
            from: "Черновик.md".to_string()
        }
    );
    assert_eq!(ev.note_id, Some(NoteId(ID_B.to_string())));

    std::thread::sleep(Duration::from_millis(1200));
    let all = events.lock().unwrap().clone();
    assert_eq!(all.len(), 1, "матч по id должен схлопнуть пару: {all:?}");
    w.stop().unwrap();
}

#[test]
fn plain_delete_emits_removed() {
    let tv = TempVault::new();
    tv.write("Уходящая.md", &note(ID_A, "тело"));
    let (events, cb) = collector();
    let w = watcher::start(&tv.root, Arc::new(NoEcho), cb).unwrap();

    fs::remove_file(tv.abs("Уходящая.md")).unwrap();

    let ev = wait_for(&events, "removed", |all| {
        all.iter()
            .find(|e| e.path == "Уходящая.md" && e.kind == WatchEventKind::Removed)
            .cloned()
    });
    assert_eq!(ev.note_id, Some(NoteId(ID_A.to_string())));
    assert_eq!(ev.rev, None);
    w.stop().unwrap();
}

#[test]
fn nonatomic_chunked_write_single_event_after_stabilization() {
    let tv = TempVault::new();
    let base = note(ID_A, "старт");
    tv.write("Дамп.md", &base);
    let (events, cb) = collector();
    let w = watcher::start(&tv.root, Arc::new(NoEcho), cb).unwrap();

    let chunks = ["кусок один ", "кусок два ", "кусок три"];
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(tv.abs("Дамп.md"))
        .unwrap();
    for chunk in chunks {
        file.write_all(chunk.as_bytes()).unwrap();
        file.flush().unwrap();
        std::thread::sleep(Duration::from_millis(120));
    }
    drop(file);

    let final_content = format!("{base}{}", chunks.concat());
    let ev = wait_for(&events, "единственный modified после стабилизации", |all| {
        all.iter()
            .find(|e| e.path == "Дамп.md" && e.kind == WatchEventKind::Modified)
            .cloned()
    });
    assert_eq!(ev.rev, Some(expected_rev(&final_content)));

    std::thread::sleep(Duration::from_millis(1200));
    let all = events.lock().unwrap().clone();
    assert_eq!(all.len(), 1, "куски должны склеиться в одно событие: {all:?}");
    w.stop().unwrap();
}

#[test]
fn internal_and_temp_paths_are_ignored() {
    let tv = TempVault::new();
    fs::create_dir_all(tv.abs(".graphite")).unwrap();
    fs::create_dir_all(tv.abs(".trash")).unwrap();
    fs::create_dir_all(tv.abs("target")).unwrap();
    let (events, cb) = collector();
    let w = watcher::start(&tv.root, Arc::new(NoEcho), cb).unwrap();

    tv.write(".graphite/служебная.md", "кэш");
    tv.write(".trash/удалённая.md", &note(ID_A, "в корзине"));
    tv.write("target/сборка.md", "мусор");
    tv.write("Заметка.md.tmp", "временный файл писателя");
    tv.write(".скрытая.md", "точка-файл");
    tv.write("картинка.png", "не markdown");

    assert_silence(&events, 2000);

    let live = note(ID_B, "живая");
    tv.write("Живая.md", &live);
    let ev = wait_for(&events, "created для обычной заметки", |all| {
        all.iter()
            .find(|e| e.path == "Живая.md" && e.kind == WatchEventKind::Created)
            .cloned()
    });
    assert_eq!(ev.rev, Some(expected_rev(&live)));
    assert_eq!(events.lock().unwrap().len(), 1);
    w.stop().unwrap();
}
