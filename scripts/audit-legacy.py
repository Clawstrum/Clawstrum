#!/usr/bin/env python3
"""Aggregate an OFFLINE NanoClaw messages.db copy. Never emits conversation text.

Usage: python3 scripts/audit-legacy.py LABEL=/path/to/offline/messages.db [LABEL2=/path/to/another.db ...]
Only Python's standard library is required. Use a SQLite backup or a consistent database+WAL copy; copying only the main file can omit committed data.
"""
import collections
import json
import pathlib
import sqlite3
import statistics
import sys


def inspect(filename):
    path = pathlib.Path(filename).resolve()
    db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
    try:
        db.row_factory = sqlite3.Row
        rows = list(db.execute('SELECT * FROM messages ORDER BY timestamp'))
        human = [r for r in rows if not r['is_from_me'] and not r['is_bot_message']]
        outbound = [r for r in rows if r['is_from_me'] or r['is_bot_message']]
        lengths = sorted(len(r['content'] or '') for r in outbound)
        tables = {}
        for name, in db.execute("SELECT name FROM sqlite_master WHERE type='table'"):
            quoted = '"' + name.replace('"', '""') + '"'
            tables[name] = db.execute('SELECT count(*) FROM ' + quoted).fetchone()[0]
        return {
            'integrity': db.execute('PRAGMA integrity_check').fetchone()[0],
            'tables': tables,
            'date_range': [rows[0]['timestamp'], rows[-1]['timestamp']] if rows else [],
            'total': len(rows), 'human_by_flags': len(human), 'outbound_or_bot_by_flags': len(outbound),
            'active_chats': len({r['chat_jid'] for r in rows}),
            'outbound_chars_median': statistics.median(lengths) if lengths else None,
            'outbound_chars_p90': lengths[int(.9 * (len(lengths) - 1))] if lengths else None,
            'task_schedule_types': dict(db.execute('SELECT schedule_type,count(*) FROM scheduled_tasks GROUP BY schedule_type')),
            'task_results': dict(db.execute('SELECT status,count(*) FROM task_run_logs GROUP BY status')),
        }
    finally:
        db.close()


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    result = {}
    for argument in sys.argv[1:]:
        label, filename = argument.split('=', 1)
        result[label] = inspect(filename)
    print(json.dumps(result, indent=2))
