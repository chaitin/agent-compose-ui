package apitoken

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStoreCreateAuthenticateListAndRevoke(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tokens.db")
	store, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	created, err := store.Create(t.Context(), "readonly test", RoleReadOnlyAdmin)
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
	if err != nil || len(items) != 1 || items[0].ID != created.ID {
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

func TestAuthenticateRejectsMalformedAndUnknownTokens(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "tokens.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	_, unknown, err := generateToken()
	if err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{"", "invalid", unknown} {
		if _, err := store.Authenticate(context.Background(), raw); err != ErrInvalidToken {
			t.Errorf("Authenticate(%q) = %v", raw, err)
		}
	}
}
