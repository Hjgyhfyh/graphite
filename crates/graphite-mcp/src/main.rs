//! graphite-mcp — тонкий stdio-клиент Model Context Protocol (SPEC §7.1):
//! весь стейт и запись — в ядре Graphite через named pipe `\\.\pipe\graphite-core`.
//! Запуск: `graphite-mcp --vault "D:\Vault"`.

mod args;
mod service;

use std::path::PathBuf;
use std::process::ExitCode;

use rmcp::{ServiceExt, transport::stdio};

use crate::service::GraphiteService;

fn parse_vault_arg(mut argv: impl Iterator<Item = String>) -> Result<PathBuf, String> {
    while let Some(arg) = argv.next() {
        if arg == "--vault" {
            return argv
                .next()
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .ok_or_else(|| "после --vault ожидается путь к vault".to_string());
        }
        if let Some(value) = arg.strip_prefix("--vault=") {
            if value.is_empty() {
                return Err("после --vault= ожидается путь к vault".to_string());
            }
            return Ok(PathBuf::from(value));
        }
    }
    Err("обязательный аргумент --vault <путь> не указан".to_string())
}

#[tokio::main]
async fn main() -> ExitCode {
    let vault = match parse_vault_arg(std::env::args().skip(1)) {
        Ok(vault) => vault,
        Err(message) => {
            eprintln!("graphite-mcp: {message}");
            return ExitCode::from(2);
        }
    };
    let running = match GraphiteService::new(vault).serve(stdio()).await {
        Ok(running) => running,
        Err(err) => {
            eprintln!("graphite-mcp: не удалось запустить MCP-сервер на stdio: {err}");
            return ExitCode::FAILURE;
        }
    };
    if let Err(err) = running.waiting().await {
        eprintln!("graphite-mcp: аварийное завершение: {err}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
