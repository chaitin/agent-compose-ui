package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"agent-compose-ui/internal/config"

	"github.com/samber/do/v2"
)

func TestRegisterBuildsHTTPServer(t *testing.T) {
	t.Setenv("AUTH_PASSWORD", "secret")
	t.Setenv("AUTH_SECRET", "test-secret")
	t.Setenv("TOKEN_DB_PATH", "")

	di := do.New()
	Register(di)

	server := do.MustInvoke[*http.Server](di)
	if server.Addr != config.DefaultListenAddr {
		t.Fatalf("server addr = %q, want %q", server.Addr, config.DefaultListenAddr)
	}
	if server.Handler == nil {
		t.Fatal("server handler is nil")
	}
	tokenServer := do.MustInvokeNamed[*http.Server](di, "token")
	if tokenServer.Addr != tokenListenAddr || tokenServer.Handler == nil {
		t.Fatalf("token server = %#v", tokenServer)
	}
	if err := do.MustInvoke[*TokenRuntime](di).Close(); err != nil {
		t.Fatal(err)
	}
}

func TestTokenManagementAndMachineProxyIntegration(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if value := r.Header.Get("Authorization"); value != "" {
			t.Errorf("managed authorization reached daemon: %q", value)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	t.Setenv("AUTH_PASSWORD", "")
	t.Setenv("AUTH_SECRET", "")
	t.Setenv("AGENT_COMPOSE_URL", upstream.URL)
	t.Setenv("TOKEN_DB_PATH", t.TempDir()+"/tokens.db")

	di := do.New()
	Register(di)
	t.Cleanup(func() { _ = do.MustInvoke[*TokenRuntime](di).Close() })
	browser := do.MustInvoke[*http.Server](di).Handler
	machine := do.MustInvokeNamed[*http.Server](di, "token").Handler

	create := httptest.NewRequest(http.MethodPost, "/ui-api/v1/tokens", strings.NewReader(`{"name":"automation","role":"admin","expiresInDays":90}`))
	create.Header.Set("Content-Type", "application/json")
	createdResponse := httptest.NewRecorder()
	browser.ServeHTTP(createdResponse, create)
	if createdResponse.Code != http.StatusCreated {
		t.Fatalf("create status = %d: %s", createdResponse.Code, createdResponse.Body.String())
	}
	var created struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(createdResponse.Body.Bytes(), &created); err != nil || created.Token == "" {
		t.Fatalf("created response = %q, err = %v", createdResponse.Body.String(), err)
	}

	request := httptest.NewRequest(http.MethodPatch, "/future/write-api", nil)
	request.Header.Set("Authorization", "Bearer "+created.Token)
	response := httptest.NewRecorder()
	machine.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("proxy status = %d: %s", response.Code, response.Body.String())
	}
}

func TestTokenManagementRouteUsesBrowserAuthentication(t *testing.T) {
	t.Setenv("AUTH_PASSWORD", "password")
	t.Setenv("AUTH_SECRET", "secret")
	t.Setenv("TOKEN_DB_PATH", t.TempDir()+"/tokens.db")
	di := do.New()
	Register(di)
	t.Cleanup(func() { _ = do.MustInvoke[*TokenRuntime](di).Close() })

	response := httptest.NewRecorder()
	do.MustInvoke[*http.Server](di).Handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/ui-api/v1/tokens", nil))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
}
