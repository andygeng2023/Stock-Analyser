"""Direct TiDB PostgreSQL access for GitHub Actions workers."""
import json
import os
import re
import shlex
from typing import Any, Mapping, Sequence

import psycopg
from psycopg import sql
from psycopg.rows import dict_row


def normalize_dsn(value: str) -> str:
    """Normalize the command copied from TiDB's PostgreSQL CLI connection panel."""
    dsn = str(value or "").strip()
    if not dsn:
        raise RuntimeError("DATABASE_URL is missing; configure the TiDB connection string as a GitHub Actions secret.")

    # Some TiDB console copies include the psql command in front of the conninfo.
    for prefix in ("\\\\psql ", "\\psql ", "psql "):
        if dsn.startswith(prefix):
            dsn = dsn[len(prefix):].strip()
            break

    # Remove shell quoting when the entire conninfo was copied as one argument.
    if dsn.startswith(("'", '"')):
        try:
            parts = shlex.split(dsn)
            if len(parts) == 1:
                dsn = parts[0]
        except ValueError as exc:
            raise RuntimeError("DATABASE_URL contains unmatched shell quotes.") from exc

        r"(?i)(\bdbname\s*=\s*)[\"']?<DB>;?[\"']?",
    # The starter instance's built-in database is named postgres. A semicolon
    # copied immediately after <DB> is part of the placeholder text, not a
    # libpq attribute separator, so replace the whole placeholder.
    dsn = re.sub(
        r"(?i)(\bdbname\s*=\s*)[\"']?<DB>;?[\"']?",
        r"\1postgres",
        dsn,
    )

    # Also accept PostgreSQL URIs copied with the database placeholder.
    dsn = re.sub(
        r"(?i)(/)<DB>(?=[?;]|$)",
        r"\1postgres",
        dsn,
    )
    return dsn


def connect():
    dsn = normalize_dsn(os.environ.get("DATABASE_URL", ""))
    return psycopg.connect(
        dsn,
        connect_timeout=15,
        row_factory=dict_row,
        application_name="stock-analyser-actions",
    )


def _val(column, value):
    if column == "result" and value is not None and not isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return value


def fetch_all(query: str, params: Sequence[Any] = ()):
    with connect() as conn, conn.cursor() as cur:
        cur.execute(query, params)
        return list(cur.fetchall())


def fetch_one(query: str, params: Sequence[Any] = ()):
    with connect() as conn, conn.cursor() as cur:
        cur.execute(query, params)
        return cur.fetchone()


def execute(query: str, params: Sequence[Any] = ()):
    with connect() as conn, conn.cursor() as cur:
        cur.execute(query, params)
        return cur.rowcount


def _insert_sql(table, record, conflict_columns):
    columns = list(record)
    query = sql.SQL("INSERT INTO {} ({}) VALUES ({})").format(
        sql.Identifier(table),
        sql.SQL(", ").join(map(sql.Identifier, columns)),
        sql.SQL(", ").join(sql.Placeholder() for _ in columns),
    )
    if conflict_columns is not None:
        updates = [c for c in columns if c not in conflict_columns]
        if updates:
            query += sql.SQL(" ON CONFLICT ({}) DO UPDATE SET {}").format(
                sql.SQL(", ").join(map(sql.Identifier, conflict_columns)),
                sql.SQL(", ").join(
                    sql.SQL("{}=EXCLUDED.{}").format(sql.Identifier(c), sql.Identifier(c))
                    for c in updates
                ),
            )
        else:
            query += sql.SQL(" ON CONFLICT ({}) DO NOTHING").format(
                sql.SQL(", ").join(map(sql.Identifier, conflict_columns))
            )
    return query, tuple(_val(c, record[c]) for c in columns)


def insert_one(table: str, record: Mapping[str, Any]):
    query, values = _insert_sql(table, record, None)
    with connect() as conn, conn.cursor() as cur:
        cur.execute(query, values)
    return dict(record)


def upsert_one(table: str, record: Mapping[str, Any], conflict_columns: Sequence[str]):
    query, values = _insert_sql(table, record, conflict_columns)
    with connect() as conn, conn.cursor() as cur:
        cur.execute(query, values)
    return dict(record)


def upsert_many(table: str, records, conflict_columns: Sequence[str]):
    if not records:
        return 0
    columns = list(records[0])
    if any(list(row) != columns for row in records):
        raise ValueError(f"Inconsistent columns in {table} batch.")
    query, _ = _insert_sql(table, records[0], conflict_columns)
    values = [tuple(_val(c, row[c]) for c in columns) for row in records]
    with connect() as conn, conn.cursor() as cur:
        cur.executemany(query, values)
        return cur.rowcount


def update_one(table: str, key_column: str, key_value, fields: Mapping[str, Any]):
    if not fields:
        return 0
    columns = list(fields)
    query = sql.SQL("UPDATE {} SET {} WHERE {}=%s").format(
        sql.Identifier(table),
        sql.SQL(", ").join(sql.SQL("{}=%s").format(sql.Identifier(c)) for c in columns),
        sql.Identifier(key_column),
    )
    values = tuple(_val(c, fields[c]) for c in columns) + (key_value,)
    with connect() as conn, conn.cursor() as cur:
        cur.execute(query, values)
        return cur.rowcount
