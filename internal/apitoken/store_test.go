package apitoken

import (
	"database/sql"
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
	created, err := store.Create(t.Context(), "readonly test", RoleReadOnlyAdmin, 90*24*time.Hour)
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
	items, err := store.List(t.Context())
	if err != nil || len(items) != 1 || items[0].ExpiresAt == nil || !items[0].ExpiresAt.Equal(*created.ExpiresAt) {
		t.Fatalf("List() = %#v, %v", items, err)
	}
	if err := store.Revoke(t.Context(), created.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.Revoke(t.Context(), created.ID); err != nil {
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
	created, err := store.Create(t.Context(), "short-lived", RoleAdmin, 24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	store.now = func() time.Time { return baseTime.Add(24 * time.Hour) }
	if _, err := store.Authenticate(t.Context(), created.Token); err != ErrInvalidToken {
		t.Fatalf("Authenticate() at expiry = %v", err)
	}
}

func TestOpenStoreMigratesLegacyTokensWithoutExpiringThem(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tokens.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE api_token (
		id TEXT PRIMARY KEY,
		secret_hash BLOB NOT NULL,
		name TEXT NOT NULL,
		role TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		revoked_at INTEGER
	)`)
	if err != nil {
		t.Fatal(err)
	}
	parsed, raw, err := generateToken()
	if err != nil {
		t.Fatal(err)
	}
	digest := secretDigest(parsed.secret)
	if _, err := db.Exec(`INSERT INTO api_token(id, secret_hash, name, role, created_at) VALUES(?,?,?,?,?)`, parsed.id, digest[:], "legacy", RoleAdmin, 1); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if _, err := store.Authenticate(t.Context(), raw); err != nil {
		t.Fatalf("Authenticate() legacy token = %v", err)
	}
	items, err := store.List(t.Context())
	if err != nil || len(items) != 1 || items[0].ExpiresAt != nil {
		t.Fatalf("List() = %#v, %v", items, err)
	}
}
