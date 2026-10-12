package tasks

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"agent-compose-ui/internal/config"
)

var testFields = []config.SandboxTaskField{
	{Title: "payload.body.title", URL: "payload.body.metadata.url"},
	{Title: "payload.body.event.payload.body.title", URL: "payload.body.event.payload.body.metadata.url"},
}

// serve runs one request against a handler backed by the given daemon stub.
func serve(t *testing.T, fields []config.SandboxTaskField, backend http.HandlerFunc, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	server := httptest.NewServer(backend)
	t.Cleanup(server.Close)
	backendURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	New(backendURL, fields).ServeHTTP(recorder, httptest.NewRequest(method, path, strings.NewReader(body)))
	return recorder
}

func TestTaskFromPayload(t *testing.T) {
	for name, tc := range map[string]struct {
		payload   string
		wantTitle string
		wantURL   string
		wantOK    bool
	}{
		"first field": {
			payload:   `{"payload":{"body":{"title":" Fix login ","metadata":{"url":"https://tracker.example/issues/1"}}}}`,
			wantTitle: "Fix login", wantURL: "https://tracker.example/issues/1", wantOK: true,
		},
		"later field": {
			payload:   `{"payload":{"body":{"event":{"payload":{"body":{"title":"Nested","metadata":{"url":"http://tracker.example/2"}}}}}}}`,
			wantTitle: "Nested", wantURL: "http://tracker.example/2", wantOK: true,
		},
		"title without link":     {payload: `{"payload":{"body":{"title":"No link"}}}`, wantTitle: "No link", wantOK: true},
		"unsafe link is dropped": {payload: `{"payload":{"body":{"title":"T","metadata":{"url":"javascript:alert(1)"}}}}`, wantTitle: "T", wantOK: true},
		"relative link dropped":  {payload: `{"payload":{"body":{"title":"T","metadata":{"url":"/issues/1"}}}}`, wantTitle: "T", wantOK: true},
		"non-string title":       {payload: `{"payload":{"body":{"title":{"text":"x"}}}}`},
		"path through array":     {payload: `{"payload":[{"body":{"title":"x"}}]}`},
		"no task":                {payload: `{"payload":{"body":{"commit_sha":"abc"}}}`},
		"empty":                  {payload: ""},
		"not json":               {payload: "task"},
	} {
		t.Run(name, func(t *testing.T) {
			title, link, ok := taskFromPayload(parsePayload(tc.payload), testFields)
			if title != tc.wantTitle || link != tc.wantURL || ok != tc.wantOK {
				t.Fatalf("taskFromPayload() = (%q, %q, %v), want (%q, %q, %v)", title, link, ok, tc.wantTitle, tc.wantURL, tc.wantOK)
			}
		})
	}
}

func TestSandboxTasksReturnOnlyConfiguredFields(t *testing.T) {
	var requests []string
	recorder := serve(t, testFields, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agentcompose.v2.ProjectService/BatchGetLatestSchedulerRuns" {
			t.Errorf("unexpected backend path %q", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		requests = append(requests, string(body))
		_, _ = w.Write([]byte(`{"results":[
			{"sandboxId":"sb-1","run":{"payloadJson":"{\"payload\":{\"body\":{\"title\":\"Fix login\",\"callback\":{\"url\":\"https://tracker.example/cb?sig=secret\"},\"metadata\":{\"url\":\"https://tracker.example/issues/1\"}}}}"}},
			{"sandboxId":"sb-2","run":{"payloadJson":"{\"payload\":{\"body\":{\"commit_sha\":\"abc\"}}}"}},
			{"sandboxId":"sb-3"}
		]}`))
	}, http.MethodPost, "/api/ui/v1/sandbox-tasks",
		`{"sandboxes":[{"sandbox_id":"sb-1","project_id":"p-1"},{"sandbox_id":"sb-2","project_id":"p-1"},{"sandbox_id":"sb-3","project_id":"p-1"},{"sandbox_id":"orphan","project_id":""}]}`)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "secret") {
		t.Fatalf("response leaked payload content: %s", recorder.Body.String())
	}
	want := `{"enabled":true,"tasks":[{"sandbox_id":"sb-1","title":"Fix login","url":"https://tracker.example/issues/1"}]}`
	if got := strings.TrimSpace(recorder.Body.String()); got != want {
		t.Fatalf("response = %s, want %s", got, want)
	}
	if len(requests) != 1 || requests[0] != `{"project":{"projectId":"p-1"},"sandboxIds":["sb-1","sb-2","sb-3"]}` {
		t.Fatalf("backend requests = %q", requests)
	}
}

func TestLookupsDisabledWithoutFields(t *testing.T) {
	for path, body := range map[string]string{
		"/api/ui/v1/sandbox-tasks": `{"sandboxes":[{"sandbox_id":"sb-1","project_id":"p-1"}]}`,
		"/api/ui/v1/event-tasks":   `{"event_ids":["evt-1"]}`,
	} {
		recorder := serve(t, nil, func(http.ResponseWriter, *http.Request) {
			t.Error("backend must not be called when no task fields are configured")
		}, http.MethodPost, path, body)
		if got := strings.TrimSpace(recorder.Body.String()); recorder.Code != http.StatusOK || got != `{"enabled":false,"tasks":[]}` {
			t.Fatalf("%s response = %d %s", path, recorder.Code, got)
		}
	}
}

func TestSandboxTasksReportBackendFailure(t *testing.T) {
	recorder := serve(t, testFields, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "project not found", http.StatusNotFound)
	}, http.MethodPost, "/api/ui/v1/sandbox-tasks", `{"sandboxes":[{"sandbox_id":"sb-1","project_id":"p-1"}]}`)
	if recorder.Code != http.StatusBadGateway || !strings.Contains(recorder.Body.String(), "project not found") {
		t.Fatalf("response = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestEventTasksReadEventPayloads(t *testing.T) {
	recorder := serve(t, testFields, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/events/evt-1":
			_, _ = w.Write([]byte(`{"event":{"event_id":"evt-1","payload":{"body":{"title":"Fix login","metadata":{"url":"https://tracker.example/issues/1"},"callback":{"url":"https://tracker.example/cb?sig=secret"}}}}}`))
		case "/api/events/evt-2":
			_, _ = w.Write([]byte(`{"event":{"event_id":"evt-2","payload":{"body":{"kind":"stop"}}}}`))
		default:
			http.NotFound(w, r)
		}
	}, http.MethodPost, "/api/ui/v1/event-tasks", `{"event_ids":["evt-1","evt-2","evt-missing"]}`)

	want := `{"enabled":true,"tasks":[{"event_id":"evt-1","title":"Fix login","url":"https://tracker.example/issues/1"}]}`
	if got := strings.TrimSpace(recorder.Body.String()); recorder.Code != http.StatusOK || got != want {
		t.Fatalf("response = %d %s, want %s", recorder.Code, got, want)
	}
}

// listBackend serves two agents: a router and a worker handling the same task,
// plus a housekeeping agent whose runs carry no task.
func listBackend(t *testing.T) http.HandlerFunc {
	task := func(correlation, event, title string) string {
		payload, _ := json.Marshal(map[string]any{"payload": map[string]any{
			"correlationId": correlation, "eventId": event,
			"body": map[string]any{"title": title, "metadata": map[string]any{"url": "https://tracker.example/" + correlation}},
		}})
		return string(payload)
	}
	runs := map[string][]map[string]any{
		"router": {
			{"runId": "r-2", "schedulerId": "s-router", "status": "SCHEDULER_RUN_STATUS_SUCCEEDED", "startedAt": "2026-10-12T02:00:00Z", "completedAt": "2026-10-12T02:00:02Z", "durationMs": "2000", "payloadJson": task("task-b", "evt-b1", "Second task")},
			{"runId": "r-1", "schedulerId": "s-router", "status": "SCHEDULER_RUN_STATUS_SUCCEEDED", "startedAt": "2026-10-12T01:00:00Z", "completedAt": "2026-10-12T01:00:02Z", "payloadJson": task("task-a", "evt-a1", "First task")},
		},
		"worker": {
			{"runId": "w-3", "schedulerId": "s-worker", "status": "SCHEDULER_RUN_STATUS_RUNNING", "startedAt": "2026-10-12T02:00:03Z", "payloadJson": task("task-b", "evt-b2", "Second task"), "sandboxIds": []string{"sb-b"}},
			{"runId": "w-2", "schedulerId": "s-worker", "status": "SCHEDULER_RUN_STATUS_SUCCEEDED", "startedAt": "2026-10-12T01:30:00Z", "completedAt": "2026-10-12T01:31:00Z", "payloadJson": task("task-a", "evt-a3", "First task")},
			{"runId": "w-1", "schedulerId": "s-worker", "status": "SCHEDULER_RUN_STATUS_FAILED", "startedAt": "2026-10-12T01:00:03Z", "completedAt": "2026-10-12T01:00:09Z", "error": "exit 1", "payloadJson": task("task-a", "evt-a2", "First task")},
		},
		"cleaner": {
			{"runId": "c-1", "schedulerId": "s-cleaner", "status": "SCHEDULER_RUN_STATUS_SUCCEEDED", "startedAt": "2026-10-12T03:00:00Z", "payloadJson": `{"payload":{"body":{"kind":"sweep"}}}`},
		},
	}
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/agentcompose.v2.ProjectService/ListSchedulers":
			_, _ = w.Write([]byte(`{"schedulers":[
				{"schedulerId":"s-router","projectId":"p-1","agentName":"router","displayName":"Ingress","runCount":2},
				{"schedulerId":"s-worker","projectId":"p-1","agentName":"worker","displayName":"Worker","runCount":3},
				{"schedulerId":"s-cleaner","projectId":"p-1","agentName":"cleaner","displayName":"Cleaner","runCount":900},
				{"schedulerId":"s-idle","projectId":"p-1","agentName":"idle","displayName":"Idle"}
			]}`))
		case "/agentcompose.v2.ProjectService/ListSchedulerRuns":
			var input struct {
				AgentName string `json:"agentName"`
			}
			_ = json.NewDecoder(r.Body).Decode(&input)
			if input.AgentName == "idle" {
				t.Error("agents without runs must not be queried")
			}
			total := len(runs[input.AgentName])
			switch input.AgentName {
			case "cleaner":
				total = 900
			case "worker":
				total = 400
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"runs": runs[input.AgentName], "total": total})
		default:
			t.Errorf("unexpected backend path %q", r.URL.Path)
		}
	}
}

func TestListTasksGroupsExecutionsByCorrelation(t *testing.T) {
	recorder := serve(t, testFields, listBackend(t), http.MethodGet, "/api/ui/v1/tasks", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var got listResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.TitlesEnabled || !got.Truncated || len(got.Tasks) != 2 {
		t.Fatalf("response = %#v", got)
	}
	second, first := got.Tasks[0], got.Tasks[1]
	if second.Title != "Second task" || second.Status != statusRunning || len(second.Executions) != 2 || second.URL != "https://tracker.example/task-b" {
		t.Fatalf("newest task = %#v", second)
	}
	// The worker failed once and then succeeded on a retry.
	if first.Title != "First task" || first.Status != statusSucceeded || first.StartedAt != "2026-10-12T01:00:00Z" || first.LatestAt != "2026-10-12T01:31:00Z" {
		t.Fatalf("oldest task = %#v", first)
	}
	var order []string
	for _, execution := range first.Executions {
		order = append(order, execution.RunID)
	}
	if strings.Join(order, ",") != "r-1,w-1,w-2" {
		t.Fatalf("execution order = %v", order)
	}
	failed := first.Executions[1]
	if failed.Status != statusFailed || failed.Error != "exit 1" || failed.SchedulerName != "Worker" || failed.EventID != "evt-a2" || failed.AgentName != "worker" {
		t.Fatalf("failed execution = %#v", failed)
	}
	if got.Tasks[0].Executions[0].DurationMs != 2000 {
		t.Fatalf("duration = %d", got.Tasks[0].Executions[0].DurationMs)
	}
}

func TestListTasksWithoutFieldsListsEveryExecution(t *testing.T) {
	recorder := serve(t, nil, listBackend(t), http.MethodGet, "/api/ui/v1/tasks", "")
	var got listResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.TitlesEnabled || len(got.Tasks) != 3 || got.Tasks[0].Key != "run:c-1" || got.Tasks[0].Title != "" {
		t.Fatalf("response = %#v", got)
	}
}

func TestSummarizeError(t *testing.T) {
	if got := summarizeError("  exit 1\n"); got != "exit 1" {
		t.Fatalf("short error = %q", got)
	}
	got := []rune(summarizeError(strings.Repeat("错", maxErrorRunes+50)))
	if len(got) != maxErrorRunes+1 || got[len(got)-1] != '…' {
		t.Fatalf("long error has %d runes, ends with %q", len(got), got[len(got)-1])
	}
}

func TestListTasksCachesAndSkipsTasklessAgents(t *testing.T) {
	// The handler reads agents concurrently, so the backend counts under a lock.
	var mu sync.Mutex
	counts := map[string]int{}
	queried := func(agent string) int {
		mu.Lock()
		defer mu.Unlock()
		return counts[agent]
	}
	inner := listBackend(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/ListSchedulerRuns") {
			body, _ := io.ReadAll(r.Body)
			var input struct {
				AgentName string `json:"agentName"`
			}
			_ = json.Unmarshal(body, &input)
			mu.Lock()
			counts[input.AgentName]++
			mu.Unlock()
			r.Body = io.NopCloser(strings.NewReader(string(body)))
		}
		inner(w, r)
	}))
	defer server.Close()
	backendURL, _ := url.Parse(server.URL)
	handler := New(backendURL, testFields)
	clock := time.Date(2026, 10, 12, 4, 0, 0, 0, time.UTC)
	handler.now = func() time.Time { return clock }
	list := func() string {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/ui/v1/tasks", nil))
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
		}
		return recorder.Body.String()
	}

	first := list()
	if again := list(); again != first || queried("worker") != 1 {
		t.Fatalf("second request within the cache window read the backend again: worker read %d times", queried("worker"))
	}
	clock = clock.Add(listCacheTTL)
	if rebuilt := list(); rebuilt != first {
		t.Fatalf("list changed after leaving out the taskless agent:\n%s\n%s", first, rebuilt)
	}
	if queried("worker") != 2 || queried("cleaner") != 1 {
		t.Fatalf("after the cache expired: worker read %d times, cleaner %d; want 2 and 1", queried("worker"), queried("cleaner"))
	}
	clock = clock.Add(tasklessAgentTTL)
	list()
	if queried("cleaner") != 2 {
		t.Fatalf("taskless agent was not rechecked: cleaner read %d times", queried("cleaner"))
	}
}
