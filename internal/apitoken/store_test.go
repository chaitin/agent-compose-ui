package apitoken

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStoreCreateAuthenticateListAndRevoke(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tokens.db")
	store, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	baseTime := time.Date(2026, 7, 23, 1, 2, 3, 0, time.UTC)
	store.now = func() time.Time { return baseTime }
	created, err := store.Create(t.Context(), "local:alice", "readonly test", RoleReadOnlyAdmin, 90*24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(created.Token, tokenPrefix) {
		t.Fatalf("token = %q", created.Token)
	}
	identity, err := store.Authenticate(t.Context(), created.Token)
	if err != nil || identity.ID != created.ID || identity.Role != RoleReadOnlyAdmin {
		t.Fatalf("Authenticate() = %#v, %v", identity, err)
	}
	items, err := store.List(t.Context(), "local:alice")
	if err != nil || len(items) != 1 || items[0].ExpiresAt == nil || !items[0].ExpiresAt.Equal(*created.ExpiresAt) {
		t.Fatalf("List() = %#v, %v", items, err)
	}
	if other, err := store.List(t.Context(), "local:bob"); err != nil || len(other) != 0 {
		t.Fatalf("other user's List() = %#v, %v", other, err)
	}
	if err := store.Revoke(t.Context(), "local:bob", created.ID); !errors.Is(err, ErrTokenNotFound) {
		t.Fatalf("other user's Revoke() = %v", err)
	}
	if err := store.Revoke(t.Context(), "local:alice", created.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.Revoke(t.Context(), "local:alice", created.ID); err != nil {
		t.Fatalf("second Revoke() = %v", err)
	}
	if _, err := store.Authenticate(t.Context(), created.Token); err != ErrInvalidToken {
		t.Fatalf("Authenticate() after revoke = %v", err)
	}

	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	database, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(created.Token, "_")
	if strings.Contains(string(database), created.Token) || strings.Contains(string(database), parts[len(parts)-1]) {
		t.Fatal("database contains raw token material")
	}
}

func TestAuthenticateRejectsExpiredToken(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "tokens.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	baseTime := time.Date(2026, 7, 23, 0, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return baseTime }
	created, err := store.Create(t.Context(), "local:alice", "short-lived", RoleAdmin, 24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	store.now = func() time.Time { return baseTime.Add(24 * time.Hour) }
	if _, err := store.Authenticate(t.Context(), created.Token); err != ErrInvalidToken {
		t.Fatalf("Authenticate() at expiry = %v", err)
	}
}

func TestOpenStoreRecordsInitialMigration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tokens.db")
	store, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	var name, checksum string
	if err := store.db.QueryRow(`SELECT name, checksum FROM ui_schema_migrations WHERE version=1`).Scan(&name, &checksum); err != nil {
		t.Fatal(err)
	}
	if name != "0001_initial.sql" || checksum == "" {
		t.Fatalf("migration = (%q, %q)", name, checksum)
	}
}
