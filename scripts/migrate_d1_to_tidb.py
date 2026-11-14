"""One-time, repeatable export from the retired D1 API into TiDB."""
import json
import os
import sys
import urllib.error
import urllib.request

import psycopg

SOURCE_API = os.environ.get("D1_EXPORT_API_URL", "https://stock-analyser-api.stock-analyser-2026.workers.dev").rstrip("/")
SOURCE_TOKEN = os.environ["CLOUDFLARE_ADMIN_API_TOKEN"]
DATABASE_URL = os.environ["DATABASE_URL"]
PAGE_SIZE = 250

TABLES = [
    ("users", "id"),
    ("sessions", "token_hash"),
    ("watchlist_items", "id"),
    ("analysis_jobs", "id"),
    ("market_index", "ticker,period,horizon,indexer"),
    ("market_index_catalog", "ticker"),
    ("api_rate_limits", "bucket_key"),
]

def fetch_page(table, offset):
    url = f"{SOURCE_API}/internal/rest/v1/{table}?limit={PAGE_SIZE}&offset={offset}"
    request = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {SOURCE_TOKEN}",
        "Accept": "application/json",
        "User-Agent": "StockAnalyser-TiDB-Migration/1.0",
    })
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1000]
        raise RuntimeError(f"D1 export failed for {table}: HTTP {exc.code}: {detail}") from exc

def fetch_table(table):
    rows, offset = [], 0
    while True:
        page = fetch_page(table, offset)
        if not isinstance(page, list):
            raise RuntimeError(f"D1 export returned an invalid payload for {table}.")
        rows.extend(page)
        print(f"Exported {len(rows)} {table} rows.")
        if len(page) < PAGE_SIZE:
            return rows
        offset += PAGE_SIZE

def json_value(value):
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return value

def import_table(cursor, table, conflict_columns, rows):
    if not rows:
        print(f"No {table} rows to import.")
        return 0
    columns = list(rows[0].keys())
    if any(set(row.keys()) != set(columns) for row in rows):
        raise RuntimeError(f"Inconsistent columns in D1 export for {table}.")
    placeholders = ", ".join(["%s"] * len(columns))
    conflict = [item.strip() for item in conflict_columns.split(",")]
    updates = [column for column in columns if column not in conflict]
    conflict_sql = ", ".join(conflict)
    if updates:
        update_sql = ", ".join(f"{name}=EXCLUDED.{name}" for name in updates)
        suffix = f" ON CONFLICT ({conflict_sql}) DO UPDATE SET {update_sql}"
    else:
        suffix = f" ON CONFLICT ({conflict_sql}) DO NOTHING"
    sql = f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({placeholders}){suffix}"
    cursor.executemany(sql, [tuple(json_value(row.get(column)) for column in columns) for row in rows])
    print(f"Imported/upserted {len(rows)} {table} rows.")
    return len(rows)

def main():
    if not SOURCE_TOKEN:
        raise RuntimeError("CLOUDFLARE_ADMIN_API_TOKEN is missing.")
    exported = {table: fetch_table(table) for table, _ in TABLES}
    schema_path = os.path.join(os.path.dirname(__file__), "..", "tidb", "schema.sql")
    with open(schema_path, encoding="utf-8") as schema_file:
        statements = [item.strip() for item in schema_file.read().split(";") if item.strip()]
    totals = {}
    with psycopg.connect(DATABASE_URL) as connection:
        with connection.cursor() as cursor:
            for statement in statements:
                cursor.execute(statement)
            for table, conflict_columns in TABLES:
                totals[table] = import_table(cursor, table, conflict_columns, exported[table])
        connection.commit()
    print("TiDB migration complete:")
    for table, count in totals.items():
        print(f"  {table}: {count}")
    print("The original D1 source has not been modified or deleted.")

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Migration failed: {error}", file=sys.stderr)
        raise
