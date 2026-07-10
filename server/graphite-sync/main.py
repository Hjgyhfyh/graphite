"""Graphite Sync — HTTP-сервис синхронизации заметок (протокол v1).

Один процесс FastAPI + uvicorn, зависимости: только fastapi и uvicorn.
Хранение: BASE_DIR/<sha256(code)>/ ; файлы в data/, метаданные в SQLite index.db (WAL).
Идентификация хранилища — sha256(код); сам код нигде не сохраняется.
Все мутации на конкретное хранилище сериализуются пер-vault замком.
"""

from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone
from typing import Iterator, Optional

from fastapi import FastAPI, Header, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

# --------------------------------------------------------------------------- #
# Конфигурация
# --------------------------------------------------------------------------- #

SERVICE = "graphite-sync"
PROTO_V = 1

BASE_DIR = os.environ.get("GRAPHITE_SYNC_DATA", "/var/lib/graphite-sync")

MAX_FILE_BYTES = 20 * 1024 * 1024        # 20 МБ на файл  -> 413
MAX_VAULT_BYTES = 2 * 1024 * 1024 * 1024  # 2 ГБ на хранилище -> 507
READ_CHUNK = 1 << 16                      # 64 КиБ на чтение при отдаче/приёме

# Код доступа: GRPH- + 4 группы по 5 символов алфавита Крокфорда (0-9 A-Z без I L O U).
CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
CODE_RE = re.compile(r"^GRPH-[%s]{5}-[%s]{5}-[%s]{5}-[%s]{5}$" % (CROCKFORD, CROCKFORD, CROCKFORD, CROCKFORD))

os.makedirs(BASE_DIR, exist_ok=True)

app = FastAPI(title="Graphite Sync", version=str(PROTO_V), docs_url=None, redoc_url=None, openapi_url=None)


# --------------------------------------------------------------------------- #
# Пер-vault замки (сериализация мутаций)
# --------------------------------------------------------------------------- #

_locks_guard = threading.Lock()
_vault_locks: dict[str, threading.Lock] = {}


def _vault_lock(vault_hash: str) -> threading.Lock:
    with _locks_guard:
        lk = _vault_locks.get(vault_hash)
        if lk is None:
            lk = threading.Lock()
            _vault_locks[vault_hash] = lk
        return lk


# --------------------------------------------------------------------------- #
# Ошибки как исключения -> JSON
# --------------------------------------------------------------------------- #

class ApiError(Exception):
    def __init__(self, status: int, payload: dict):
        self.status = status
        self.payload = payload


def _err(status: int, **payload) -> ApiError:
    return ApiError(status, payload)


# --------------------------------------------------------------------------- #
# Аутентификация / идентификация хранилища
# --------------------------------------------------------------------------- #

def _extract_code(authorization: Optional[str]) -> str:
    """Достаёт код из 'Authorization: Bearer <код>' и проверяет формат. Иначе 401."""
    if not authorization:
        raise _err(401, error="unauthorized")
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].strip().lower() != "bearer":
        raise _err(401, error="unauthorized")
    code = parts[1].strip()
    if not CODE_RE.match(code):
        raise _err(401, error="unauthorized")
    return code


def _vault_hash(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def _vault_dir(vault_hash: str) -> str:
    return os.path.join(BASE_DIR, vault_hash)


def _data_dir(vault_hash: str) -> str:
    return os.path.join(_vault_dir(vault_hash), "data")


def _db_path(vault_hash: str) -> str:
    return os.path.join(_vault_dir(vault_hash), "index.db")


# --------------------------------------------------------------------------- #
# Валидация путей (строго по протоколу)
# --------------------------------------------------------------------------- #

_IGNORE_PREFIXES = (".graphite/", ".trash/", ".obsidian/")
_IGNORE_EXACT = {"desktop.ini", "thumbs.db"}


def _validate_path(path: str) -> str:
    """Возвращает нормализованный относительный путь либо кидает 400.

    Запрещены: пустая строка, ведущий '/', обратный слэш, '\\0',
    сегменты '', '.', '..'. Разделитель — только '/'.
    """
    if not path or path == "":
        raise _err(400, error="bad_path")
    if "\x00" in path:
        raise _err(400, error="bad_path")
    if "\\" in path:
        raise _err(400, error="bad_path")
    if path.startswith("/"):
        raise _err(400, error="bad_path")
    segments = path.split("/")
    for seg in segments:
        if seg == "" or seg == "." or seg == "..":
            raise _err(400, error="bad_path")
    return path


def _abs_data_path(vault_hash: str, rel_path: str) -> str:
    """Собирает абсолютный путь внутри data/ и жёстко проверяет, что не вышли наружу."""
    root = os.path.realpath(_data_dir(vault_hash))
    candidate = os.path.realpath(os.path.join(root, rel_path))
    if candidate != root and not candidate.startswith(root + os.sep):
        raise _err(400, error="bad_path")
    return candidate


# --------------------------------------------------------------------------- #
# SQLite слой
# --------------------------------------------------------------------------- #

def _connect(vault_hash: str) -> sqlite3.Connection:
    conn = sqlite3.connect(_db_path(vault_hash), timeout=30.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_vault(vault_hash: str) -> None:
    """Создаёт каталоги и таблицы хранилища. Идемпотентно."""
    os.makedirs(_data_dir(vault_hash), exist_ok=True)
    conn = _connect(vault_hash)
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS files (
                path      TEXT PRIMARY KEY,
                hash      TEXT,
                size      INTEGER NOT NULL DEFAULT 0,
                mtime_utc TEXT NOT NULL,
                rev       INTEGER NOT NULL,
                deleted   INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_files_rev ON files(rev);
            INSERT OR IGNORE INTO meta(key, value) VALUES ('rev', '0');
            """
        )
        conn.commit()
    finally:
        conn.close()


def _get_rev(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT value FROM meta WHERE key='rev'").fetchone()
    return int(row["value"]) if row else 0


def _bump_rev(conn: sqlite3.Connection) -> int:
    new_rev = _get_rev(conn) + 1
    conn.execute("UPDATE meta SET value=? WHERE key='rev'", (str(new_rev),))
    return new_rev


def _vault_exists(vault_hash: str) -> bool:
    return os.path.isfile(_db_path(vault_hash))


def _vault_total_bytes(conn: sqlite3.Connection, exclude_path: Optional[str] = None) -> int:
    if exclude_path is None:
        row = conn.execute("SELECT COALESCE(SUM(size),0) AS s FROM files WHERE deleted=0").fetchone()
    else:
        row = conn.execute(
            "SELECT COALESCE(SUM(size),0) AS s FROM files WHERE deleted=0 AND path<>?",
            (exclude_path,),
        ).fetchone()
    return int(row["s"])


# --------------------------------------------------------------------------- #
# Утилиты
# --------------------------------------------------------------------------- #

def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _sha256_file(abs_path: str) -> str:
    h = hashlib.sha256()
    with open(abs_path, "rb", buffering=0) as f:
        while True:
            chunk = f.read(READ_CHUNK)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _row_to_manifest(row: sqlite3.Row) -> dict:
    return {
        "path": row["path"],
        "hash": row["hash"],
        "size": int(row["size"]),
        "mtimeUtc": row["mtime_utc"],
        "rev": int(row["rev"]),
        "deleted": bool(row["deleted"]),
    }


# --------------------------------------------------------------------------- #
# Middleware: единый обработчик ApiError
# --------------------------------------------------------------------------- #

@app.middleware("http")
async def _api_error_mw(request: Request, call_next):
    try:
        return await call_next(request)
    except ApiError as e:
        return JSONResponse(status_code=e.status, content=e.payload)


# --------------------------------------------------------------------------- #
# Роуты
# --------------------------------------------------------------------------- #

@app.get("/health")
def health():
    return {"ok": True, "service": SERVICE, "v": PROTO_V}


@app.post("/v1/vault")
def create_vault(authorization: Optional[str] = Header(default=None)):
    code = _extract_code(authorization)
    vh = _vault_hash(code)
    with _vault_lock(vh):
        _ensure_vault(vh)
        conn = _connect(vh)
        try:
            rev = _get_rev(conn)
        finally:
            conn.close()
    return {"vaultId": vh[:12], "rev": rev}


@app.get("/v1/manifest")
def manifest(authorization: Optional[str] = Header(default=None)):
    code = _extract_code(authorization)
    vh = _vault_hash(code)
    if not _vault_exists(vh):
        raise _err(404, error="no_vault")
    conn = _connect(vh)
    try:
        rev = _get_rev(conn)
        rows = conn.execute(
            "SELECT path, hash, size, mtime_utc, rev, deleted FROM files ORDER BY rev ASC"
        ).fetchall()
    finally:
        conn.close()
    return {"rev": rev, "files": [_row_to_manifest(r) for r in rows]}


@app.get("/v1/changes")
def changes(since: int = Query(default=0), authorization: Optional[str] = Header(default=None)):
    code = _extract_code(authorization)
    vh = _vault_hash(code)
    if not _vault_exists(vh):
        raise _err(404, error="no_vault")
    conn = _connect(vh)
    try:
        rev = _get_rev(conn)
        rows = conn.execute(
            "SELECT path, hash, size, mtime_utc, rev, deleted FROM files WHERE rev>? ORDER BY rev ASC",
            (int(since),),
        ).fetchall()
    finally:
        conn.close()
    return {"rev": rev, "files": [_row_to_manifest(r) for r in rows]}


@app.get("/v1/file")
def get_file(path: str = Query(...), authorization: Optional[str] = Header(default=None)):
    code = _extract_code(authorization)
    vh = _vault_hash(code)
    if not _vault_exists(vh):
        raise _err(404, error="no_vault")
    rel = _validate_path(path)
    conn = _connect(vh)
    try:
        row = conn.execute("SELECT deleted FROM files WHERE path=?", (rel,)).fetchone()
    finally:
        conn.close()
    if row is None or int(row["deleted"]) == 1:
        raise _err(404, error="not_found")
    abs_path = _abs_data_path(vh, rel)
    if not os.path.isfile(abs_path):
        raise _err(404, error="not_found")

    size = os.path.getsize(abs_path)

    def _iter() -> Iterator[bytes]:
        with open(abs_path, "rb", buffering=0) as f:
            while True:
                chunk = f.read(READ_CHUNK)
                if not chunk:
                    break
                yield chunk

    return StreamingResponse(
        _iter(),
        media_type="application/octet-stream",
        headers={"Content-Length": str(size)},
    )


async def _read_body_to_temp(request: Request, vault_hash: str) -> tuple[str, str, int]:
    """Стримит тело запроса во временный файл. Возвращает (tmp_path, sha256, size).

    Проверяет Content-Length (если задан) и фактический размер против MAX_FILE_BYTES.
    Кидает 413 при превышении, чистит временный файл.
    """
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            if int(cl) > MAX_FILE_BYTES:
                raise _err(413, error="too_large")
        except ValueError:
            raise _err(400, error="bad_length")

    tmp_dir = _vault_dir(vault_hash)
    os.makedirs(tmp_dir, exist_ok=True)
    tmp_path = os.path.join(tmp_dir, f".upload-{os.getpid()}-{time.time_ns()}.tmp")

    h = hashlib.sha256()
    total = 0
    try:
        with open(tmp_path, "wb", buffering=0) as f:
            async for chunk in request.stream():
                if not chunk:
                    continue
                total += len(chunk)
                if total > MAX_FILE_BYTES:
                    raise _err(413, error="too_large")
                h.update(chunk)
                f.write(chunk)
    except BaseException:
        _silent_unlink(tmp_path)
        raise
    return tmp_path, h.hexdigest(), total


def _silent_unlink(p: str) -> None:
    try:
        os.unlink(p)
    except FileNotFoundError:
        pass
    except OSError:
        pass


@app.put("/v1/file")
async def put_file(
    request: Request,
    path: str = Query(...),
    authorization: Optional[str] = Header(default=None),
    x_if_hash: Optional[str] = Header(default=None),
):
    code = _extract_code(authorization)
    vh = _vault_hash(code)
    rel = _validate_path(path)

    # Тело читаем ДО замка, чтобы не держать пер-vault lock на время сетевого приёма.
    _ensure_vault(vh)
    tmp_path, body_hash, body_size = await _read_body_to_temp(request, vh)

    try:
        with _vault_lock(vh):
            conn = _connect(vh)
            try:
                cur = conn.execute("SELECT hash, deleted FROM files WHERE path=?", (rel,)).fetchone()
                cur_hash = None
                if cur is not None and int(cur["deleted"]) == 0:
                    cur_hash = cur["hash"]

                # Предусловие X-If-Hash.
                if x_if_hash is not None:
                    want = x_if_hash.strip()
                    if want == "absent":
                        if cur_hash is not None:
                            raise _err(409, error="conflict", hash=cur_hash)
                    else:
                        if cur_hash != want:
                            raise _err(409, error="conflict", hash=cur_hash)

                # Лимит размера хранилища (исключаем текущий путь — он перезапишется).
                projected = _vault_total_bytes(conn, exclude_path=rel) + body_size
                if projected > MAX_VAULT_BYTES:
                    raise _err(507, error="vault_full")

                abs_path = _abs_data_path(vh, rel)
                os.makedirs(os.path.dirname(abs_path), exist_ok=True)
                os.replace(tmp_path, abs_path)  # атомарная замена; tmp_path «потреблён»

                mtime = _now_iso()
                new_rev = _bump_rev(conn)
                conn.execute(
                    "INSERT INTO files(path, hash, size, mtime_utc, rev, deleted) "
                    "VALUES(?,?,?,?,?,0) "
                    "ON CONFLICT(path) DO UPDATE SET "
                    "hash=excluded.hash, size=excluded.size, mtime_utc=excluded.mtime_utc, "
                    "rev=excluded.rev, deleted=0",
                    (rel, body_hash, body_size, mtime, new_rev),
                )
                conn.commit()
                return {"rev": new_rev, "hash": body_hash}
            finally:
                conn.close()
    finally:
        _silent_unlink(tmp_path)  # если replace прошёл — файла уже нет, no-op


@app.delete("/v1/file")
def delete_file(
    path: str = Query(...),
    authorization: Optional[str] = Header(default=None),
    x_if_hash: Optional[str] = Header(default=None),
):
    code = _extract_code(authorization)
    vh = _vault_hash(code)
    rel = _validate_path(path)
    if not _vault_exists(vh):
        raise _err(404, error="no_vault")

    with _vault_lock(vh):
        conn = _connect(vh)
        try:
            cur = conn.execute("SELECT hash, deleted FROM files WHERE path=?", (rel,)).fetchone()
            cur_hash = None
            if cur is not None and int(cur["deleted"]) == 0:
                cur_hash = cur["hash"]

            if x_if_hash is not None:
                want = x_if_hash.strip()
                if want == "absent":
                    if cur_hash is not None:
                        raise _err(409, error="conflict", hash=cur_hash)
                else:
                    if cur_hash != want:
                        raise _err(409, error="conflict", hash=cur_hash)

            abs_path = _abs_data_path(vh, rel)
            _silent_unlink(abs_path)

            mtime = _now_iso()
            new_rev = _bump_rev(conn)
            conn.execute(
                "INSERT INTO files(path, hash, size, mtime_utc, rev, deleted) "
                "VALUES(?,NULL,0,?,?,1) "
                "ON CONFLICT(path) DO UPDATE SET "
                "hash=NULL, size=0, mtime_utc=excluded.mtime_utc, rev=excluded.rev, deleted=1",
                (rel, mtime, new_rev),
            )
            conn.commit()
            return {"rev": new_rev}
        finally:
            conn.close()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("GRAPHITE_SYNC_PORT", "8130")), workers=1)
