//! The read-only SQLite index for a vault folder.
//!
//! `matter.sqlite` sits NEXT TO `matter.json` as a derived, disposable mirror of the
//! folder's VALID rows, so a coding agent (or an in-app SQL console) can run arbitrary
//! SQL over the typed folder. The JS projector (`core/sqlite.ts`) builds all the SQL
//! TEXT (the schema script + the insert, quoting and placeholders included) and the
//! row tuples; Rust only opens the db, runs the schema script, and parameter-binds
//! each row. It never learns what a column or a kind is, the same faithful role
//! `entry.rs` and `watch.rs` play for writes and reads.
//!
//! The rebuild is a full DROP + CREATE + INSERT in one transaction, so it is
//! disposable: delete the file, reopen the folder, get an identical table. It is
//! driven per settled watcher batch from `vault.svelte.ts`.

use rusqlite::types::Value;
use rusqlite::{Connection, OpenFlags};
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

/// Rebuild `<path>/matter.sqlite` from the projected rows. `schema` (a `DROP` + `CREATE`
/// script) and `insert` are the SQL the JS projector built; `rows` is one tuple per
/// valid row, positional against the insert's columns. Full drop-and-recreate in one
/// transaction, so the file is disposable.
#[tauri::command]
pub fn write_index(
    path: String,
    schema: String,
    insert: String,
    rows: Vec<Vec<serde_json::Value>>,
) -> Result<(), String> {
    let db = Path::new(&path).join("matter.sqlite");
    let mut conn = Connection::open(&db).map_err(|e| e.to_string())?;
    // Reconciles fire per watcher batch and each opens its own connection, so two can
    // overlap on a large folder (or with an agent reading). Wait for the lock instead of
    // failing fast with SQLITE_BUSY; the rebuild is a full drop-and-recreate, so a brief
    // wait is cheaper than a lost rebuild.
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // execute_batch runs the multi-statement DROP + CREATE script (no params).
    tx.execute_batch(&schema).map_err(|e| e.to_string())?;
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

/// One result set from `query_index`: the column names and the rows (each a positional
/// list of JSON-encoded cell values). Generic and schema-blind, like the rest of this
/// module: Rust runs the SQL and hands back values, it never interprets them.
#[derive(Debug, serde::Serialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
}

/// Turn one SQLite cell into JSON for the frontend (the inverse of `to_sql`). matter
/// never projects blobs, so a blob maps to null defensively rather than dragging in a
/// base64 dependency.
fn from_sql(value: rusqlite::types::ValueRef) -> serde_json::Value {
    use rusqlite::types::ValueRef as V;
    use serde_json::Value as J;
    match value {
        V::Null => J::Null,
        V::Integer(i) => J::Number(i.into()),
        V::Real(f) => serde_json::Number::from_f64(f).map(J::Number).unwrap_or(J::Null),
        V::Text(s) => J::String(String::from_utf8_lossy(s).into_owned()),
        V::Blob(_) => J::Null,
    }
}

/// Run a READ-ONLY query against `<path>/matter.sqlite` and return up to `limit` rows.
/// The connection is opened read-only, so a query can never mutate the disposable mirror
/// (a write would be lost on the next reconcile anyway); `busy_timeout` lets a query wait
/// out an in-flight rebuild instead of failing with SQLITE_BUSY. The SQL is the caller's
/// (the user's own query against their own local file), so Rust stays schema-blind: it
/// runs the statement and hands back column names and JSON values, nothing interpreted.
#[tauri::command]
pub fn query_index(path: String, sql: String, limit: usize) -> Result<QueryResult, String> {
    let db = Path::new(&path).join("matter.sqlite");
    let conn = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let col_count = columns.len();

    let mut out: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        if out.len() >= limit {
            break;
        }
        let mut record = Vec::with_capacity(col_count);
        for i in 0..col_count {
            record.push(from_sql(row.get_ref(i).map_err(|e| e.to_string())?));
        }
        out.push(record);
    }

    Ok(QueryResult {
        columns,
        rows: out,
    })
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

    const SCHEMA: &str = r#"DROP TABLE IF EXISTS "drafts";
CREATE TABLE "drafts" ("path" TEXT PRIMARY KEY, "title" TEXT NOT NULL, "count" INTEGER NOT NULL, "_extra" TEXT NOT NULL)"#;
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

        write_index(path, SCHEMA.into(), INSERT.into(), rows).unwrap();

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
            SCHEMA.into(),
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
            SCHEMA.into(),
            INSERT.into(),
            vec![vec![json!("only.md"), json!("Solo"), json!(9), json!("{}")]],
        )
        .unwrap();
        assert_eq!(count(&dir), 1);
    }

    #[test]
    fn query_index_reads_rows_limits_and_rejects_writes() {
        let dir = scratch();
        let path: String = dir.to_string_lossy().into();
        write_index(
            path.clone(),
            SCHEMA.into(),
            INSERT.into(),
            vec![
                vec![json!("a.md"), json!("Hello"), json!(3), json!("{}")],
                vec![json!("b.md"), json!("World"), json!(5), json!("{}")],
            ],
        )
        .unwrap();

        let result = query_index(
            path.clone(),
            r#"SELECT "path", "count" FROM "drafts" WHERE "count" > 3"#.into(),
            100,
        )
        .unwrap();
        assert_eq!(result.columns, vec!["path".to_string(), "count".to_string()]);
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0][0], json!("b.md"));
        assert_eq!(result.rows[0][1], json!(5));

        // `limit` caps the row count.
        let limited =
            query_index(path.clone(), r#"SELECT "path" FROM "drafts""#.into(), 1).unwrap();
        assert_eq!(limited.rows.len(), 1);

        // The connection is read-only, so a write is rejected, never a silent mutation.
        let err = query_index(path, r#"DELETE FROM "drafts""#.into(), 100).unwrap_err();
        assert!(err.to_lowercase().contains("readonly"));
    }
}
