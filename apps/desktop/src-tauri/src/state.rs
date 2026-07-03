use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use vault_core::indexer::Index;

/// Общее состояние ядра на процесс: корень открытого vault и его индекс.
/// Все команды берут `root`/`index` отсюда; мутации сериализуются мьютексом
/// (один писатель, SPEC §8.2).
pub struct CoreState {
    pub root: PathBuf,
    pub index: Index,
}

static CORE: OnceLock<Mutex<Option<CoreState>>> = OnceLock::new();

/// Глобальная ячейка состояния ядра (пусто, пока vault не смонтирован).
pub fn core_cell() -> &'static Mutex<Option<CoreState>> {
    CORE.get_or_init(|| Mutex::new(None))
}
