package projectenv

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func TestGlobalStoreSnapshot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "data.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE global_env (
		name TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		secret INTEGER NOT NULL DEFAULT 0,
		updated_at INTEGER NOT NULL
	)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO global_env(name,value,secret,updated_at) VALUES
		('PUBLIC_URL','https://example.test',0,1),
		('TOKEN','secret-value',1,2)`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := OpenGlobalStore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	values, err := store.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got := values["PUBLIC_URL"]; got != (GlobalValue{Value: "https://example.test"}) {
		t.Fatalf("PUBLIC_URL = %#v", got)
	}
	if got := values["TOKEN"]; got != (GlobalValue{Value: "secret-value", Secret: true}) {
		t.Fatalf("TOKEN = %#v", got)
	}
}

func TestGlobalStoreRejectsIncompatibleSchemaWithoutLeakingRows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "data.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE global_env (name TEXT PRIMARY KEY, value TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO global_env(name,value) VALUES ('TOKEN','do-not-leak')`); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	_, err = OpenGlobalStore(path)
	if err == nil || !strings.Contains(err.Error(), "global_env schema") || strings.Contains(err.Error(), "do-not-leak") {
		t.Fatalf("error = %v", err)
	}
}
