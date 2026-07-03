//! Журнал и откат (SPEC §6.8) поверх крейта `history`: журнал
//! `.graphite/journal/*.jsonl`, снапшоты `.graphite/history/objects`.
//! `history` строит план отката по журналу и снапшотам; применение плана
//! (запись/удаление файлов в vault) — здесь, поверх `writer`. Файл, изменённый
//! уже после отменяемой операции, не перезаписывается вслепую, а возвращается
//! как конфликт.

use std::path::Path;

use history::{HistoryError, UndoPlan};

use crate::error::VaultError;
use crate::indexer::Index;
use crate::model::{ActivityGetParams, JournalOp, UndoResult};
use crate::writer;

/// Каталог журнала внутри vault.
pub fn journal_dir(vault_root: &Path) -> std::path::PathBuf {
    vault_root.join(".graphite").join("journal")
}

/// Каталог снапшотов содержимого внутри vault.
pub fn objects_dir(vault_root: &Path) -> std::path::PathBuf {
    vault_root
        .join(".graphite")
        .join("history")
        .join("objects")
}

/// Дописывает журнал-операцию в месячный файл (одна мутация — одна запись) и
/// кладёт в объектное хранилище содержимое затронутых файлов в их состоянии
/// после мутации. За счёт content-addressing этот `after`-снапшот совпадает с
/// `before`-снапшотом следующей правки того же файла, поэтому откат такой правки
/// находит своё исходное содержимое. Запись журнала — источник истины; снапшоты
/// кладутся по возможности и не срывают запись при сбое отдельного объекта.
pub fn record(vault_root: &Path, op: &JournalOp) -> Result<(), VaultError> {
    history::append_op(&journal_dir(vault_root), op).map_err(hist_err)?;
    snapshot_after(vault_root, op);
    Ok(())
}

/// `journal_list` (CONTRACT §5): записи журнала по фильтрам, новые первыми.
pub fn journal_list(
    vault_root: &Path,
    params: &ActivityGetParams,
) -> Result<Vec<JournalOp>, VaultError> {
    history::journal::list(&journal_dir(vault_root), params).map_err(hist_err)
}

/// Откат одной операции: её файлы возвращаются к before-снапшотам, файлы,
/// созданные операцией, удаляются. Если хотя бы один файл изменился уже после
/// операции или его before-снапшот недоступен — диск не трогается и возвращается
/// список конфликтующих путей. Успешный откат помечает запись журнала `undone`,
/// повторный откат уже отменённой операции — no-op.
pub fn undo_op(
    vault_root: &Path,
    index: &mut Index,
    op_id: &str,
) -> Result<UndoResult, VaultError> {
    let journal = journal_dir(vault_root);
    let op = history::read_op(&journal, op_id).map_err(hist_err)?;
    if op.undone {
        return Ok(UndoResult {
            restored_files: 0,
            conflicts: Vec::new(),
        });
    }
    let plan = history::undo_plan(&journal, vault_root, op_id).map_err(hist_err)?;
    match apply_plan(vault_root, &plan)? {
        PlanOutcome::Conflicts(conflicts) => Ok(UndoResult {
            restored_files: 0,
            conflicts,
        }),
        PlanOutcome::Applied(changed) => {
            history::mark_undone(&journal, op_id, true).map_err(hist_err)?;
            index.reindex_paths(vault_root, &changed)?;
            Ok(UndoResult {
                restored_files: changed.len() as u32,
                conflicts: Vec::new(),
            })
        }
    }
}

/// Откат всей сессии: неотменённые операции откатываются в обратном
/// хронологическом порядке. План каждой операции строится заново по текущему
/// состоянию диска, чтобы учесть уже применённые внутри сессии откаты (цепочка
/// правок одного файла разматывается корректно). Конфликтующие операции
/// пропускаются, их пути попадают в общий список конфликтов; остальные —
/// помечаются `undone`.
pub fn undo_session(
    vault_root: &Path,
    index: &mut Index,
    session: &str,
) -> Result<UndoResult, VaultError> {
    let journal = journal_dir(vault_root);
    let ops = history::read_session_ops(&journal, session).map_err(hist_err)?;
    if ops.is_empty() {
        return Err(VaultError::NotFound(format!("сессия {session}")));
    }
    let mut restored: u32 = 0;
    let mut conflicts: Vec<String> = Vec::new();
    let mut changed_all: Vec<String> = Vec::new();
    for op in ops.iter().filter(|op| !op.undone) {
        let plan = history::undo_plan(&journal, vault_root, &op.op_id).map_err(hist_err)?;
        match apply_plan(vault_root, &plan)? {
            PlanOutcome::Conflicts(paths) => conflicts.extend(paths),
            PlanOutcome::Applied(changed) => {
                history::mark_undone(&journal, &op.op_id, true).map_err(hist_err)?;
                restored += changed.len() as u32;
                changed_all.extend(changed);
            }
        }
    }
    if !changed_all.is_empty() {
        index.reindex_paths(vault_root, &changed_all)?;
    }
    Ok(UndoResult {
        restored_files: restored,
        conflicts,
    })
}

/// Итог применения плана к одной операции. Применение атомарно относительно
/// конфликтов: при наличии хотя бы одного диск не трогается вовсе.
enum PlanOutcome {
    Applied(Vec<String>),
    Conflicts(Vec<String>),
}

/// Отложенное изменение файла на этапе применения чистого плана.
enum RestoreAction {
    Write { path: String, bytes: Vec<u8> },
    Remove { path: String },
}

/// Оценивает и применяет план отката. Сперва материализует before-содержимое
/// всех файлов и собирает конфликты (файл менялся после операции либо его
/// снапшот недоступен/битый); при непустом наборе конфликтов диск не меняется.
/// Чистый план записывает восстановленное содержимое и удаляет созданные
/// операцией файлы, возвращая список фактически изменённых путей.
fn apply_plan(vault_root: &Path, plan: &UndoPlan) -> Result<PlanOutcome, VaultError> {
    let objects = objects_dir(vault_root);
    let mut conflicts: Vec<String> = Vec::new();
    let mut actions: Vec<RestoreAction> = Vec::new();
    for restore in &plan.restores {
        if restore.needs_merge {
            conflicts.push(restore.path.clone());
            continue;
        }
        match &restore.restore_to {
            Some(hash) => match history::snapshot::get(&objects, hash) {
                Ok(bytes) => actions.push(RestoreAction::Write {
                    path: restore.path.clone(),
                    bytes,
                }),
                Err(HistoryError::Io(err)) => return Err(VaultError::Io(err)),
                Err(_) => conflicts.push(restore.path.clone()),
            },
            None => actions.push(RestoreAction::Remove {
                path: restore.path.clone(),
            }),
        }
    }
    if !conflicts.is_empty() {
        return Ok(PlanOutcome::Conflicts(conflicts));
    }
    let mut changed = Vec::with_capacity(actions.len());
    for action in actions {
        match action {
            RestoreAction::Write { path, bytes } => {
                writer::write_atomic(vault_root, &path, &bytes)?;
                changed.push(path);
            }
            RestoreAction::Remove { path } => {
                let abs = writer::vault_abs_path(vault_root, &path)?;
                match std::fs::remove_file(&abs) {
                    Ok(()) => {}
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                    Err(err) => return Err(VaultError::from(err)),
                }
                changed.push(path);
            }
        }
    }
    Ok(PlanOutcome::Applied(changed))
}

/// Кладёт в объектное хранилище содержимое затронутых операцией файлов, ещё
/// лежащих на диске (их состояние после мутации). Отсутствующие на диске пути
/// (удаление, источник переноса) пропускаются; ошибки отдельных снапшотов
/// проглатываются — запись журнала уже состоялась.
fn snapshot_after(vault_root: &Path, op: &JournalOp) {
    let objects = objects_dir(vault_root);
    for change in &op.files {
        let Ok(abs) = writer::vault_abs_path(vault_root, &change.path) else {
            continue;
        };
        if let Ok(bytes) = std::fs::read(&abs) {
            let _ = history::snapshot::put(&objects, &bytes);
        }
    }
}

/// Маппинг ошибок крейта `history` в доменные ошибки ядра.
pub(crate) fn hist_err(err: HistoryError) -> VaultError {
    match err {
        HistoryError::Io(e) => VaultError::Io(e),
        HistoryError::NotFound(s) => VaultError::NotFound(s),
        HistoryError::Invalid(s) => VaultError::Validation(s),
        HistoryError::Corrupt(s) => VaultError::Index(s),
    }
}
