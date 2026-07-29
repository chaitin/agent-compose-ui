package dbmigrate

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func TestInitialMigrationCreatesDatabaseAndIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ui.db")
	for range 2 {
		if err := Apply(context.Background(), path); err != nil {
			t.Fatal(err)
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	for _, table := range []string{"api_token", "audit_event", "oauth_principal"} {
		var count int
		if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&count); err != nil || count != 1 {
			t.Fatalf("table %s count=%d err=%v", table, count, err)
		}
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM ui_schema_migrations WHERE version IN (1,2) AND checksum!=''`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("migration count=%d err=%v", count, err)
	}
}

func TestInitialMigrationRegistersAnExistingBaseline(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ui.db")
	if err := Apply(context.Background(), path); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DROP TABLE ui_schema_migrations`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if err := Apply(context.Background(), path); err != nil {
		t.Fatal(err)
	}
	db, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM ui_schema_migrations`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("baseline migration count=%d err=%v", count, err)
	}
}
