//! The read-only SQLite index for a vault folder.
//!
//! `matter.sqlite` sits NEXT TO `matter.json` as a derived, disposable mirror of the
//! folder's VALID rows, so a coding agent (or an in-app SQL console) can run arbitrary
//! SQL over the typed folder. The JS projector (`model/sqlite.ts`) builds all the SQL
//! TEXT (drop / create / insert, quoting and placeholders included) and the row
//! tuples; Rust only opens the db, executes the three statements, and parameter-binds
//! each row. It never learns what a column or a kind is, the same faithful role
//! `entry.rs` and `watch.rs` play for writes and reads.
//!
//! The rebuild is a full DROP + CREATE + INSERT in one transaction, so it is
//! disposable: delete the file, reopen the folder, get an identical table. It is
//! driven per settled watcher batch from `vault.svelte.ts`.

use rusqlite::types::Value;
use rusqlite::Connection;
use std::path::Path;

/// Turn one JSON arg into a SQLite-bindable value. The projector only emits strings
/// and numbers (booleans are already 0/1, arrays are JSON text), but bool / null are
/// mapped defensively so a future projector change cannot panic here.
fn to_sql(value: &serde_json::Value) -> Value {
    use serde_json::Value as J;
    match value {
        J::String(s) => Value::Text(s.clone()),
        J::Number(n) => n
            .as_i64()
            .map(Value::Integer)
            .unwrap_or_else(|| Value::Real(n.as_f64().unwrap_or(0.0))),
        J::Bool(b) => Value::Integer(*b as i64),
        J::Null => Value::Null,
        other => Value::Text(other.to_string()),
    }
}

/// Rebuild `<path>/matter.sqlite` from the projected rows. `drop` / `ddl` / `insert`
/// are the SQL the JS projector built; `rows` is one tuple per valid row, positional
/// against the insert's columns. Full drop-and-recreate inside one transaction.
#[tauri::command]
pub fn write_index(
    path: String,
    drop: String,
    ddl: String,
    insert: String,
    rows: Vec<Vec<serde_json::Value>>,
) -> Result<(), String> {
    let db = Path::new(&path).join("matter.sqlite");
    let mut conn = Connection::open(&db).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    tx.execute(&drop, []).map_err(|e| e.to_string())?;
    tx.execute(&ddl, []).map_err(|e| e.to_string())?;
    {
        let mut stmt = tx.prepare(&insert).map_err(|e| e.to_string())?;
        for row in &rows {
            let params: Vec<Value> = row.iter().map(to_sql).collect();
            stmt.execute(rusqlite::params_from_iter(params))
                .map_err(|e| e.to_string())?;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A unique scratch dir under the OS temp dir (mirrors `entry.rs`).
    fn scratch() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "matter-index-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const DROP: &str = r#"DROP TABLE IF EXISTS "drafts""#;
    const DDL: &str = r#"CREATE TABLE "drafts" ("path" TEXT PRIMARY KEY, "title" TEXT NOT NULL, "count" INTEGER NOT NULL, "_extra" TEXT NOT NULL)"#;
    const INSERT: &str =
        r#"INSERT INTO "drafts" ("path", "title", "count", "_extra") VALUES (?, ?, ?, ?)"#;

    fn count(dir: &std::path::Path) -> i64 {
        Connection::open(dir.join("matter.sqlite"))
            .unwrap()
            .query_row(r#"SELECT COUNT(*) FROM "drafts""#, [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn writes_the_db_next_to_matter_json_with_typed_values() {
        let dir = scratch();
        let path: String = dir.to_string_lossy().into();
        let rows = vec![
            vec![json!("a.md"), json!("Hello"), json!(3), json!("{}")],
            vec![json!("b.md"), json!("World"), json!(5), json!(r#"{"k":1}"#)],
        ];

        write_index(path, DROP.into(), DDL.into(), INSERT.into(), rows).unwrap();

        // The file lands in the given folder (where matter.json lives), not elsewhere.
        assert!(dir.join("matter.sqlite").exists());

        let conn = Connection::open(dir.join("matter.sqlite")).unwrap();
        let (title, n): (String, i64) = conn
            .query_row(
                r#"SELECT "title", "count" FROM "drafts" WHERE "path" = ?"#,
                ["a.md"],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "Hello");
        assert_eq!(n, 3); // INTEGER stored and read back as a number
        assert_eq!(count(&dir), 2);
    }

    #[test]
    fn rebuild_is_a_full_drop_and_recreate() {
        let dir = scratch();
        let path: String = dir.to_string_lossy().into();

        write_index(
            path.clone(),
            DROP.into(),
            DDL.into(),
            INSERT.into(),
            vec![
                vec![json!("a.md"), json!("A"), json!(1), json!("{}")],
                vec![json!("b.md"), json!("B"), json!(2), json!("{}")],
            ],
        )
        .unwrap();
        assert_eq!(count(&dir), 2);

        // A second write with one row replaces the table wholesale (disposable).
        write_index(
            path,
            DROP.into(),
            DDL.into(),
            INSERT.into(),
            vec![vec![json!("only.md"), json!("Solo"), json!(9), json!("{}")]],
        )
        .unwrap();
        assert_eq!(count(&dir), 1);
    }
}
