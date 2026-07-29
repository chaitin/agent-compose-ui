package dbmigrate

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const migrationsTable = `CREATE TABLE IF NOT EXISTS ui_schema_migrations (
	version INTEGER PRIMARY KEY,
	name TEXT NOT NULL,
	checksum TEXT NOT NULL,
	applied_at INTEGER NOT NULL
)`

//go:embed migrations/*.sql
var migrationFiles embed.FS

func Apply(ctx context.Context, path string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return fmt.Errorf("UI database path is required")
	}
	db, err := sql.Open("sqlite", filepath.Clean(path))
	if err != nil {
		return fmt.Errorf("open UI database for migrations: %w", err)
	}
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	for _, statement := range []string{`PRAGMA journal_mode=WAL`, `PRAGMA busy_timeout=5000`, migrationsTable} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("initialize migration tracking: %w", err)
		}
	}
	migrations, err := load()
	if err != nil {
		return err
	}
	for _, migration := range migrations {
		if err := applyOne(ctx, db, migration); err != nil {
			return err
		}
	}
	return nil
}

type migration struct {
	version  int
	name     string
	checksum string
	sql      string
}

func load() ([]migration, error) {
	const directory = "migrations"
	entries, err := fs.ReadDir(migrationFiles, directory)
	if err != nil {
		return nil, fmt.Errorf("read migrations: %w", err)
	}
	result := make([]migration, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		versionText, _, ok := strings.Cut(entry.Name(), "_")
		if !ok {
			return nil, fmt.Errorf("invalid migration name %q", entry.Name())
		}
		version, err := strconv.Atoi(versionText)
		if err != nil || version <= 0 {
			return nil, fmt.Errorf("invalid migration version %q", versionText)
		}
		contents, err := migrationFiles.ReadFile(directory + "/" + entry.Name())
		if err != nil {
			return nil, fmt.Errorf("read migration %q: %w", entry.Name(), err)
		}
		digest := sha256.Sum256(contents)
		result = append(result, migration{
			version: version, name: entry.Name(), checksum: hex.EncodeToString(digest[:]), sql: string(contents),
		})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].version < result[j].version })
	for index := 1; index < len(result); index++ {
		if result[index-1].version == result[index].version {
			return nil, fmt.Errorf("duplicate migration version %d", result[index].version)
		}
	}
	return result, nil
}

func applyOne(ctx context.Context, db *sql.DB, migration migration) error {
	var name, checksum string
	err := db.QueryRowContext(ctx, `SELECT name, checksum FROM ui_schema_migrations WHERE version=?`, migration.version).Scan(&name, &checksum)
	if err == nil {
		if name != migration.name || checksum != migration.checksum {
			return fmt.Errorf("migration %04d changed after it was applied", migration.version)
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("inspect migration %04d: %w", migration.version, err)
	}
	if alreadyApplied, err := schemaAlreadyApplied(ctx, db, migration.version); err != nil {
		return err
	} else if alreadyApplied {
		if _, err := db.ExecContext(ctx, `INSERT INTO ui_schema_migrations(version, name, checksum, applied_at) VALUES(?,?,?,?)`, migration.version, migration.name, migration.checksum, time.Now().UTC().Unix()); err != nil {
			return fmt.Errorf("register migration %04d: %w", migration.version, err)
		}
		return nil
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin migration %04d: %w", migration.version, err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, migration.sql); err != nil {
		return fmt.Errorf("apply migration %04d: %w", migration.version, err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO ui_schema_migrations(version, name, checksum, applied_at) VALUES(?,?,?,?)`, migration.version, migration.name, migration.checksum, time.Now().UTC().Unix()); err != nil {
		return fmt.Errorf("record migration %04d: %w", migration.version, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit migration %04d: %w", migration.version, err)
	}
	return nil
}

func schemaAlreadyApplied(ctx context.Context, db *sql.DB, version int) (bool, error) {
	if version != 2 {
		return false, nil
	}
	rows, err := db.QueryContext(ctx, `PRAGMA table_info(api_token)`)
	if err != nil {
		return false, fmt.Errorf("inspect api token schema: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, kind string
		var defaultValue any
		if err := rows.Scan(&cid, &name, &kind, &notNull, &defaultValue, &primaryKey); err != nil {
			return false, fmt.Errorf("scan api token schema: %w", err)
		}
		if name == "owner_id" {
			return true, nil
		}
	}
	return false, rows.Err()
}
