package projectenv

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func TestHandlerResolvesApplyWithoutReturningSecret(t *testing.T) {
	globals := testGlobalStore(t, map[string]GlobalValue{"TOKEN": {Value: "secret-value", Secret: true}})
	shadows, err := OpenShadowStore(filepath.Join(t.TempDir(), "shadow.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = shadows.Close() })

	var upstreamRequest map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&upstreamRequest); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"applied": true,
			"project": map[string]any{
				"summary": map[string]any{"projectId": "project-1"},
				"spec":    upstreamRequest["spec"],
			},
			"revision": map[string]any{"specHash": "sha256:resolved", "spec": upstreamRequest["spec"]},
		})
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	handler := NewHandler(target, globals, shadows, http.NotFoundHandler())

	body := `{"spec":{"name":"demo","variables":[{"name":"MODE","value":"literal"},{"name":"AUTH","value":"Bearer ${TOKEN}"}]},"source":{"composePath":"agent-compose.yml"}}`
	request := httptest.NewRequest(http.MethodPost, applyProjectProcedure, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	upstreamSpec := upstreamRequest["spec"].(map[string]any)
	variables := envByName(t, upstreamSpec["variables"])
	if variables["MODE"]["value"] != "literal" || variables["AUTH"]["value"] != "Bearer secret-value" || variables["AUTH"]["secret"] != true {
		t.Fatalf("upstream variables = %#v", variables)
	}
	if strings.Contains(response.Body.String(), "secret-value") || !strings.Contains(response.Body.String(), `${TOKEN}`) {
		t.Fatalf("browser response leaked or lost reference: %s", response.Body.String())
	}
	shadow, found, err := shadows.Get(context.Background(), "project-1")
	if err != nil || !found || shadow.PendingSync || shadow.References[0] != "TOKEN" || !strings.Contains(shadow.SpecJSON, `${TOKEN}`) {
		t.Fatalf("shadow=%#v found=%v err=%v", shadow, found, err)
	}
}

func TestHandlerDoesNotSaveShadowWhenApplyFails(t *testing.T) {
	globals := testGlobalStore(t, map[string]GlobalValue{"TOKEN": {Value: "secret-value", Secret: true}})
	shadows, err := OpenShadowStore(filepath.Join(t.TempDir(), "shadow.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = shadows.Close() })
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"code":"internal"}`, http.StatusInternalServerError)
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	handler := NewHandler(target, globals, shadows, http.NotFoundHandler())
	request := httptest.NewRequest(http.MethodPost, applyProjectProcedure, strings.NewReader(`{"spec":{"name":"demo","variables":[{"name":"AUTH","value":"${TOKEN}"}]}}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", response.Code)
	}
	if _, found, err := shadows.Get(context.Background(), "project-1"); err != nil || found {
		t.Fatalf("shadow found=%v err=%v", found, err)
	}
}

func TestHandlerRedactsResolvedSecretFromValidateResponse(t *testing.T) {
	globals := testGlobalStore(t, map[string]GlobalValue{"TOKEN": {Value: "secret-value", Secret: true}})
	shadows, err := OpenShadowStore(filepath.Join(t.TempDir(), "shadow.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = shadows.Close() })
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"valid":true,"changes":[{"after":"Bearer secret-value"}]}`)
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	handler := NewHandler(target, globals, shadows, http.NotFoundHandler())
	request := httptest.NewRequest(http.MethodPost, validateProjectProcedure, strings.NewReader(`{"spec":{"variables":[{"name":"AUTH","value":"Bearer ${TOKEN}"}]}}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), "secret-value") {
		t.Fatalf("validate response leaked resolved secret: status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestGlobalUpdateOnlyMarksDependentProjectsPending(t *testing.T) {
	globals, dbPath := testGlobalStoreWithPath(t, map[string]GlobalValue{
		"TOKEN": {Value: "old-value", Secret: true},
	})
	shadows, err := OpenShadowStore(filepath.Join(t.TempDir(), "shadow.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = shadows.Close() })
	if err := shadows.SaveApplied(context.Background(), ShadowProject{
		ProjectID: "dependent", SpecJSON: `{"name":"dependent"}`, References: []string{"TOKEN"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := shadows.SaveApplied(context.Background(), ShadowProject{
		ProjectID: "literal", SpecJSON: `{"name":"literal"}`,
	}); err != nil {
		t.Fatal(err)
	}

	var paths []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		db, openErr := sql.Open("sqlite", dbPath)
		if openErr != nil {
			t.Fatal(openErr)
		}
		if _, updateErr := db.Exec(`UPDATE global_env SET value='new-value',updated_at=2 WHERE name='TOKEN'`); updateErr != nil {
			t.Fatal(updateErr)
		}
		_ = db.Close()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"env":[{"name":"TOKEN","value":"new-value","secret":true}]}`)
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	handler := NewHandler(target, globals, shadows, http.NotFoundHandler())
	request := httptest.NewRequest(http.MethodPost, updateGlobalEnvProcedure, strings.NewReader(`{"env":[{"name":"TOKEN","value":"new-value","secret":true}]}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK || !reflect.DeepEqual(paths, []string{updateGlobalEnvProcedure}) {
		t.Fatalf("status=%d paths=%#v body=%s", response.Code, paths, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "new-value") || !strings.Contains(response.Body.String(), "********") {
		t.Fatalf("global update response leaked secret: %s", response.Body.String())
	}
	dependent, _, _ := shadows.Get(context.Background(), "dependent")
	literal, _, _ := shadows.Get(context.Background(), "literal")
	if !dependent.PendingSync || literal.PendingSync {
		t.Fatalf("dependent=%#v literal=%#v", dependent, literal)
	}
}

func TestProjectStatusReadsPendingStateWithoutCallingUpstream(t *testing.T) {
	globals := testGlobalStore(t, nil)
	shadows, err := OpenShadowStore(filepath.Join(t.TempDir(), "shadow.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = shadows.Close() })
	if err := shadows.SaveApplied(context.Background(), ShadowProject{
		ProjectID: "project-1", SpecJSON: `{"name":"demo"}`, References: []string{"TOKEN"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := shadows.MarkReferencesPending(context.Background(), []string{"TOKEN"}); err != nil {
		t.Fatal(err)
	}

	upstreamCalls := 0
	fallback := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamCalls++
		http.Error(w, "unexpected upstream request", http.StatusBadGateway)
	})
	target, _ := url.Parse("http://127.0.0.1:1")
	handler := NewHandler(target, globals, shadows, fallback)
	request := httptest.NewRequest(http.MethodGet, "/api/project-env/status?project_id=project-1", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK || upstreamCalls != 0 {
		t.Fatalf("status=%d upstreamCalls=%d body=%s", response.Code, upstreamCalls, response.Body.String())
	}
	if got := decodeBody(t, response.Body); got["pendingSync"] != true {
		t.Fatalf("status body = %#v", got)
	}
}

func TestGetGlobalEnvRedactsSecretResponse(t *testing.T) {
	globals := testGlobalStore(t, nil)
	shadows, err := OpenShadowStore(filepath.Join(t.TempDir(), "shadow.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = shadows.Close() })
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"env":[{"name":"TOKEN","value":"stored-secret","secret":true},{"name":"REGION","value":"east","secret":false}]}`)
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	handler := NewHandler(target, globals, shadows, http.NotFoundHandler())
	request := httptest.NewRequest(http.MethodPost, "/agentcompose.v2.SettingsService/GetGlobalEnv", strings.NewReader(`{}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), "stored-secret") || !strings.Contains(response.Body.String(), "east") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func testGlobalStore(t *testing.T, values map[string]GlobalValue) *GlobalStore {
	t.Helper()
	store, _ := testGlobalStoreWithPath(t, values)
	return store
}

func testGlobalStoreWithPath(t *testing.T, values map[string]GlobalValue) (*GlobalStore, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "data.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE global_env(name TEXT PRIMARY KEY,value TEXT NOT NULL,secret INTEGER NOT NULL,updated_at INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	for name, value := range values {
		secret := 0
		if value.Secret {
			secret = 1
		}
		if _, err := db.Exec(`INSERT INTO global_env(name,value,secret,updated_at) VALUES(?,?,?,1)`, name, value.Value, secret); err != nil {
			t.Fatal(err)
		}
	}
	_ = db.Close()
	store, err := OpenGlobalStore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store, path
}

func decodeBody(t *testing.T, body io.Reader) map[string]any {
	t.Helper()
	data, err := io.ReadAll(body)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.NewDecoder(bytes.NewReader(data)).Decode(&value); err != nil {
		t.Fatalf("decode %s: %v", data, err)
	}
	return value
}
