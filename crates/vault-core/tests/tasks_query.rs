use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use vault_core::indexer::Index;
use vault_core::vault::query;
use vault_core::{NoteRef, TasksQueryParams};

const ID_PLAN: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ID_NOTE: &str = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

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
            "graphite-tasks-query-{}-{}-{}",
            std::process::id(),
            seq,
            nanos
        ));
        fs::create_dir_all(&root).unwrap();
        Self { root }
    }

    fn write(&self, rel: &str, content: &str) {
        let path = self.root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content.replace("\r\n", "\n")).unwrap();
    }
}

impl Drop for TempVault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn index_of(vault: &TempVault) -> Index {
    let db = vault.root.join(".graphite").join("index.sqlite");
    let mut index = Index::open(&db).unwrap();
    index.rebuild(&vault.root).unwrap();
    index
}

#[test]
fn tasks_query_отдаёт_path_как_в_дереве() {
    let vault = TempVault::new();
    vault.write(
        "Проекты/План MVP.md",
        &format!(
            "---\nid: {ID_PLAN}\ntype: plan\ntitle: План MVP\n---\n\n- [ ] Первый шаг ^t-aaaa\n"
        ),
    );
    vault.write(
        "Идеи/Искра.md",
        &format!("---\nid: {ID_NOTE}\ntitle: Искра\n---\n\n- [ ] Просто задача\n"),
    );

    let index = index_of(&vault);
    let resp = query::tasks_query(
        &vault.root,
        &index,
        &TasksQueryParams {
            scope: None,
            status: None,
            due_before: None,
            overdue: None,
            plan: None,
            limit: None,
        },
    )
    .unwrap();

    assert_eq!(resp.tasks.len(), 2, "{resp:?}");

    let plan = resp
        .tasks
        .iter()
        .find(|t| t.text == "Первый шаг")
        .expect("задача плана");
    assert_eq!(plan.source.r#ref, NoteRef("path:Проекты/План MVP.md".into()));
    assert_eq!(plan.plan, Some(NoteRef("path:Проекты/План MVP.md".into())));

    let spark = resp
        .tasks
        .iter()
        .find(|t| t.text == "Просто задача")
        .expect("инлайн-задача");
    assert_eq!(spark.source.r#ref, NoteRef("path:Идеи/Искра.md".into()));
    assert_eq!(spark.plan, None);
}
