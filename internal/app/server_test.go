package app

import (
	"net/http"
	"testing"

	"agent-compose-ui/internal/config"

	"github.com/samber/do/v2"
)

func TestRegisterBuildsHTTPServer(t *testing.T) {
	t.Setenv("AUTH_PASSWORD", "secret")
	t.Setenv("AUTH_SECRET", "test-secret")

	di := do.New()
	Register(di)

	server := do.MustInvoke[*http.Server](di)
	if server.Addr != config.DefaultListenAddr {
		t.Fatalf("server addr = %q, want %q", server.Addr, config.DefaultListenAddr)
	}
	if server.Handler == nil {
		t.Fatal("server handler is nil")
	}
}
