package projectenv

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

type GlobalStore struct {
	db *sql.DB
}

func OpenGlobalStore(path string) (*GlobalStore, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("global environment database path is required")
	}
	dsn := "file:" + filepath.ToSlash(filepath.Clean(path)) + "?mode=ro"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open global environment database: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	store := &GlobalStore{db: db}
	if err := store.validateSchema(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *GlobalStore) Snapshot(ctx context.Context) (map[string]GlobalValue, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("global environment store is not open")
	}
	rows, err := s.db.QueryContext(ctx, `SELECT name, value, secret FROM global_env ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("read global environment: %w", err)
	}
	defer func() { _ = rows.Close() }()
	result := make(map[string]GlobalValue)
	for rows.Next() {
		var name, value string
		var secret int
		if err := rows.Scan(&name, &value, &secret); err != nil {
			return nil, fmt.Errorf("scan global environment row: %w", err)
		}
		name = strings.TrimSpace(name)
		if name != "" {
			result[name] = GlobalValue{Value: value, Secret: secret != 0}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate global environment: %w", err)
	}
	return result, nil
}

func (s *GlobalStore) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *GlobalStore) validateSchema(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `PRAGMA table_info(global_env)`)
	if err != nil {
		return fmt.Errorf("inspect global_env schema: %w", err)
	}
	defer func() { _ = rows.Close() }()
	columns := make(map[string]bool)
	for rows.Next() {
		var index, notNull, primaryKey int
		var name, columnType string
		var defaultValue any
		if err := rows.Scan(&index, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			return fmt.Errorf("inspect global_env schema: %w", err)
		}
		columns[name] = true
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("inspect global_env schema: %w", err)
	}
	for _, required := range []string{"name", "value", "secret"} {
		if !columns[required] {
			return fmt.Errorf("global_env schema is missing required column %s", required)
		}
	}
	return nil
}
