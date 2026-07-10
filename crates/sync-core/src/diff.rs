//! Ядро дифф-логики: чистое 3-way сравнение (база = индекс прошлого синка,
//! локаль = скан реплики, удалённое = записи сервера) → план шагов. Без сети и
//! без диска: на вход три снимка, на выход [`Plan`]. Максимум юнит-тестов здесь —
//! это основная страховка качества клиента.

use std::collections::BTreeMap;

use chrono::{DateTime, Local};

use crate::index::{FileState, SyncIndex};

/// Максимальный размер файла для пуша (протокол: 20 МБ, иначе сервер 413).
/// Клиент сам пропускает превышающие, иначе 409/413 повторялся бы каждый цикл.
pub const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;

/// Запись манифеста/изменений сервера.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteEntry {
    pub path: String,
    pub hash: String,
    pub size: i64,
    pub mtime_utc: String,
    pub rev: i64,
    pub deleted: bool,
}

/// Один шаг плана синхронизации.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanStep {
    /// Скачать удалённую версию и записать локально.
    PullWrite { path: String, remote_hash: String },
    /// Удалить локальный файл (применён серверный томбстоун).
    PullDelete { path: String },
    /// Залить локальный файл. `base_hash` = ожидаемое серверное состояние
    /// (`X-If-Hash`), `None` — файла на сервере быть не должно (`"absent"`).
    PushPut {
        path: String,
        base_hash: Option<String>,
    },
    /// Положить томбстоун удаления с предусловием `base_hash`.
    PushDelete {
        path: String,
        base_hash: Option<String>,
    },
    /// Обоюдная правка: локальную версию переименовать в «(конфликт …)» и залить
    /// под этим именем, в канон положить удалённую версию.
    ConflictLocalRename {
        path: String,
        conflict_path: String,
        remote_hash: String,
    },
}

/// Упорядоченный набор шагов одного направления сравнения.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Plan {
    pub steps: Vec<PlanStep>,
}

/// Имя файла-конфликта: `<имя> (конфликт <hostname> <YYYY-MM-DD HH-mm>).<ext>`.
/// Расширение (последняя точка базового имени) сохраняется; путь-каталог остаётся
/// прежним. Двоеточия времени заменены дефисами (недопустимы в именах Windows).
pub fn conflict_name(path: &str, hostname: &str, now: DateTime<Local>) -> String {
    let stamp = now.format("%Y-%m-%d %H-%M").to_string();
    let (dir, base) = match path.rfind('/') {
        Some(idx) => (&path[..=idx], &path[idx + 1..]),
        None => ("", path),
    };
    // Делим базовое имя на stem/ext по последней точке (не ведущей — скрытые
    // файлы вида «.gitignore» остаются целиком в stem).
    let (stem, ext) = match base.rfind('.') {
        Some(idx) if idx > 0 => (&base[..idx], &base[idx..]),
        _ => (base, ""),
    };
    format!("{dir}{stem} (конфликт {hostname} {stamp}){ext}")
}

/// Не менялся ли локальный файл с прошлого синка: хеш локали совпадает с базой
/// (или пути нет ни там, ни там — тоже «не менялся»).
fn local_unchanged(index: &SyncIndex, local: &BTreeMap<String, FileState>, path: &str) -> bool {
    let base = index.files.get(path);
    let cur = local.get(path);
    match (base, cur) {
        (Some(b), Some(c)) => b.hash == c.hash,
        (None, None) => true,
        // Файл появился локально ИЛИ исчез локально относительно базы — изменился.
        _ => false,
    }
}

/// Шаг (2): применение удалённых изменений (записи с `rev > since`).
///
/// Для каждой удалённой записи: если локаль не расходится с базой — принять
/// (`PullWrite`/`PullDelete`); если локаль изменена и хеш разошёлся с удалённым —
/// конфликт (`ConflictLocalRename`). Совпадение локали с удалённым хешем — no-op
/// (обе стороны пришли к одному содержимому).
pub fn plan_apply_remote(
    index: &SyncIndex,
    local: &BTreeMap<String, FileState>,
    changes: &[RemoteEntry],
    hostname: &str,
    now: DateTime<Local>,
) -> Plan {
    let mut steps = Vec::new();
    for entry in changes {
        let path = &entry.path;
        let local_state = local.get(path);
        if entry.deleted {
            match local_state {
                None => {
                    // Локально уже нет — ничего делать не нужно.
                }
                Some(cur) => {
                    if local_unchanged(index, local, path) {
                        steps.push(PlanStep::PullDelete { path: path.clone() });
                    } else {
                        // Файл изменён локально, а на сервере удалён — конфликт:
                        // сохранить локальную правку под именем конфликта, канон
                        // оставить удалённым (PullDelete канона выполнит движок
                        // после переноса; здесь фиксируем перенос локали в конфликт).
                        let conflict = conflict_name(path, hostname, now);
                        steps.push(PlanStep::ConflictLocalRename {
                            path: path.clone(),
                            conflict_path: conflict,
                            remote_hash: String::new(),
                        });
                    }
                    let _ = cur;
                }
            }
            continue;
        }
        // Обычная (не удалённая) удалённая запись.
        match local_state {
            Some(cur) if cur.hash == entry.hash => {
                // Локаль уже совпадает с сервером — принимать нечего.
            }
            _ => {
                if local_unchanged(index, local, path) {
                    steps.push(PlanStep::PullWrite {
                        path: path.clone(),
                        remote_hash: entry.hash.clone(),
                    });
                } else {
                    let conflict = conflict_name(path, hostname, now);
                    steps.push(PlanStep::ConflictLocalRename {
                        path: path.clone(),
                        conflict_path: conflict,
                        remote_hash: entry.hash.clone(),
                    });
                }
            }
        }
    }
    Plan { steps }
}

/// Шаг (3): сбор локальных изменений относительно базы → `PushPut`/`PushDelete`.
///
/// `base_hash` = хеш из индекса (`None` = `absent` для новых файлов). Файлы
/// крупнее [`MAX_FILE_BYTES`] пропускаются (иначе сервер вернул бы 413 в цикле).
/// Пути, которых нет в скане, но есть в базе, дают `PushDelete`.
pub fn plan_push_local(index: &SyncIndex, local: &BTreeMap<String, FileState>) -> Vec<PlanStep> {
    let mut steps = Vec::new();
    // Новые/изменённые: есть локально.
    for (path, state) in local {
        if state.size > MAX_FILE_BYTES {
            continue;
        }
        let base = index.files.get(path);
        match base {
            Some(b) if b.hash == state.hash => {
                // Не изменился — пропускаем.
            }
            Some(b) => steps.push(PlanStep::PushPut {
                path: path.clone(),
                base_hash: Some(b.hash.clone()),
            }),
            None => steps.push(PlanStep::PushPut {
                path: path.clone(),
                base_hash: None,
            }),
        }
    }
    // Удалённые локально: были в базе, нет в скане.
    for (path, b) in &index.files {
        if !local.contains_key(path) {
            steps.push(PlanStep::PushDelete {
                path: path.clone(),
                base_hash: Some(b.hash.clone()),
            });
        }
    }
    steps
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::sha256_hex;
    use chrono::TimeZone;

    fn fs_state(content: &[u8]) -> FileState {
        FileState {
            hash: sha256_hex(content),
            size: content.len() as u64,
            mtime_utc: "2026-01-01T00:00:00.000Z".to_string(),
        }
    }

    fn remote(path: &str, content: &[u8], rev: i64) -> RemoteEntry {
        RemoteEntry {
            path: path.to_string(),
            hash: sha256_hex(content),
            size: content.len() as i64,
            mtime_utc: "2026-01-01T00:00:00.000Z".to_string(),
            rev,
            deleted: false,
        }
    }

    fn tombstone(path: &str, rev: i64) -> RemoteEntry {
        RemoteEntry {
            path: path.to_string(),
            hash: String::new(),
            size: 0,
            mtime_utc: "2026-01-01T00:00:00.000Z".to_string(),
            rev,
            deleted: true,
        }
    }

    fn now() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 7, 10, 14, 30, 0).single().unwrap()
    }

    fn map(pairs: &[(&str, &[u8])]) -> BTreeMap<String, FileState> {
        pairs
            .iter()
            .map(|(p, c)| (p.to_string(), fs_state(c)))
            .collect()
    }

    fn index_with(last_rev: i64, pairs: &[(&str, &[u8])]) -> SyncIndex {
        SyncIndex {
            last_rev,
            files: map(pairs),
        }
    }

    #[test]
    fn clean_pull_untouched_local() {
        // База и локаль совпадают; сервер прислал новую версию файла a.
        let index = index_with(1, &[("a.md", b"old")]);
        let local = map(&[("a.md", b"old")]);
        let changes = [remote("a.md", b"new", 2)];
        let plan = plan_apply_remote(&index, &local, &changes, "PC", now());
        assert_eq!(
            plan.steps,
            vec![PlanStep::PullWrite {
                path: "a.md".to_string(),
                remote_hash: sha256_hex(b"new")
            }]
        );
    }

    #[test]
    fn clean_push_untouched_remote() {
        // Локально изменили a, добавили b; сервер эти пути не трогал.
        let index = index_with(5, &[("a.md", b"old")]);
        let local = map(&[("a.md", b"changed"), ("b.md", b"brand")]);
        let steps = plan_push_local(&index, &local);
        assert!(steps.contains(&PlanStep::PushPut {
            path: "a.md".to_string(),
            base_hash: Some(sha256_hex(b"old"))
        }));
        assert!(steps.contains(&PlanStep::PushPut {
            path: "b.md".to_string(),
            base_hash: None
        }));
        assert_eq!(steps.len(), 2);
    }

    #[test]
    fn mutual_edit_is_single_conflict_with_remote_canon() {
        // Оба изменили a.md по-разному → ровно один ConflictLocalRename с
        // удалённым хешем в качестве канона.
        let index = index_with(3, &[("a.md", b"base")]);
        let local = map(&[("a.md", b"local-edit")]);
        let changes = [remote("a.md", b"remote-edit", 4)];
        let plan = plan_apply_remote(&index, &local, &changes, "HOST", now());
        assert_eq!(plan.steps.len(), 1);
        match &plan.steps[0] {
            PlanStep::ConflictLocalRename {
                path,
                conflict_path,
                remote_hash,
            } => {
                assert_eq!(path, "a.md");
                assert_eq!(remote_hash, &sha256_hex(b"remote-edit"));
                assert!(conflict_path.contains("(конфликт HOST 2026-07-10 14-30)"));
                assert!(conflict_path.ends_with(".md"));
            }
            other => panic!("ожидался конфликт, получено {other:?}"),
        }
    }

    #[test]
    fn remote_delete_of_locally_edited_is_conflict() {
        // Сервер удалил файл, который локально изменён — конфликт (сохранить локаль).
        let index = index_with(3, &[("a.md", b"base")]);
        let local = map(&[("a.md", b"local-edit")]);
        let changes = [tombstone("a.md", 4)];
        let plan = plan_apply_remote(&index, &local, &changes, "H", now());
        assert_eq!(plan.steps.len(), 1);
        assert!(matches!(
            &plan.steps[0],
            PlanStep::ConflictLocalRename { path, remote_hash, .. }
                if path == "a.md" && remote_hash.is_empty()
        ));
    }

    #[test]
    fn new_local_only_is_push_absent() {
        let index = index_with(2, &[]);
        let local = map(&[("fresh.md", b"data")]);
        let steps = plan_push_local(&index, &local);
        assert_eq!(
            steps,
            vec![PlanStep::PushPut {
                path: "fresh.md".to_string(),
                base_hash: None
            }]
        );
    }

    #[test]
    fn tombstone_applies_as_pull_delete() {
        // Файл не менялся локально; сервер прислал томбстоун → PullDelete.
        let index = index_with(3, &[("gone.md", b"x")]);
        let local = map(&[("gone.md", b"x")]);
        let changes = [tombstone("gone.md", 4)];
        let plan = plan_apply_remote(&index, &local, &changes, "H", now());
        assert_eq!(
            plan.steps,
            vec![PlanStep::PullDelete {
                path: "gone.md".to_string()
            }]
        );
    }

    #[test]
    fn tombstone_for_absent_local_is_noop() {
        let index = index_with(3, &[]);
        let local = map(&[]);
        let changes = [tombstone("gone.md", 4)];
        let plan = plan_apply_remote(&index, &local, &changes, "H", now());
        assert!(plan.steps.is_empty());
    }

    #[test]
    fn noop_when_all_match() {
        let index = index_with(7, &[("a.md", b"same"), ("b.md", b"same2")]);
        let local = map(&[("a.md", b"same"), ("b.md", b"same2")]);
        let changes = [remote("a.md", b"same", 7)];
        // Удалённый шаг: сервер прислал ту же версию, что и локаль → no-op.
        let apply = plan_apply_remote(&index, &local, &changes, "H", now());
        assert!(apply.steps.is_empty());
        // Пуш: локаль совпадает с базой → no-op.
        let push = plan_push_local(&index, &local);
        assert!(push.is_empty());
    }

    #[test]
    fn local_delete_pushes_tombstone() {
        // Файл был в базе, исчез из локали → PushDelete с base_hash.
        let index = index_with(5, &[("a.md", b"was")]);
        let local = map(&[]);
        let steps = plan_push_local(&index, &local);
        assert_eq!(
            steps,
            vec![PlanStep::PushDelete {
                path: "a.md".to_string(),
                base_hash: Some(sha256_hex(b"was"))
            }]
        );
    }

    #[test]
    fn oversized_file_skipped_on_push() {
        let index = index_with(1, &[]);
        let mut local = BTreeMap::new();
        local.insert(
            "huge.bin".to_string(),
            FileState {
                hash: "deadbeef".to_string(),
                size: MAX_FILE_BYTES + 1,
                mtime_utc: String::new(),
            },
        );
        local.insert("ok.md".to_string(), fs_state(b"small"));
        let steps = plan_push_local(&index, &local);
        assert_eq!(steps.len(), 1);
        assert!(matches!(&steps[0], PlanStep::PushPut { path, .. } if path == "ok.md"));
    }

    #[test]
    fn conflict_name_formats_extension_and_spaces() {
        let n = now();
        assert_eq!(
            conflict_name("Идея.md", "MYPC", n),
            "Идея (конфликт MYPC 2026-07-10 14-30).md"
        );
        // С каталогом — каталог сохраняется.
        assert_eq!(
            conflict_name("Проекты/Заметка.md", "PC-1", n),
            "Проекты/Заметка (конфликт PC-1 2026-07-10 14-30).md"
        );
        // Без расширения.
        assert_eq!(
            conflict_name("README", "H", n),
            "README (конфликт H 2026-07-10 14-30)"
        );
        // Составное расширение — делится по последней точке.
        assert_eq!(
            conflict_name("archive.tar.gz", "H", n),
            "archive.tar (конфликт H 2026-07-10 14-30).gz"
        );
        // Скрытый файл (ведущая точка) остаётся целиком в stem.
        assert_eq!(
            conflict_name(".gitignore", "H", n),
            ".gitignore (конфликт H 2026-07-10 14-30)"
        );
    }

    #[test]
    fn idempotent_replan_is_empty() {
        // После синхронизации индекс = локаль = сервер; повторный план пуст.
        let index = index_with(9, &[("a.md", b"v"), ("dir/b.md", b"w")]);
        let local = map(&[("a.md", b"v"), ("dir/b.md", b"w")]);
        let changes: Vec<RemoteEntry> = Vec::new();
        let apply = plan_apply_remote(&index, &local, &changes, "H", now());
        let push = plan_push_local(&index, &local);
        assert!(apply.steps.is_empty());
        assert!(push.is_empty());
    }

    #[test]
    fn local_matches_remote_edit_is_noop_not_conflict() {
        // Обе стороны независимо пришли к одному содержимому — не конфликт.
        let index = index_with(3, &[("a.md", b"base")]);
        let local = map(&[("a.md", b"converged")]);
        let changes = [remote("a.md", b"converged", 4)];
        let plan = plan_apply_remote(&index, &local, &changes, "H", now());
        assert!(plan.steps.is_empty());
    }
}
