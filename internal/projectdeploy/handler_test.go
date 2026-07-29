package projectdeploy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"agent-compose-ui/internal/audit"
)

func TestPreviewAndApplyPreserveProjectAndAgentFields(t *testing.T) {
	var applyBodies []map[string]any
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch r.URL.Path {
		case "/agentcompose.v2.ProjectService/GetProject":
			writeJSON(w, http.StatusOK, projectFixture(false))
		case "/agentcompose.v2.ProjectService/ApplyProject":
			applyBodies = append(applyBodies, body)
			writeJSON(w, http.StatusOK, map[string]any{
				"project":  map[string]any{"summary": map[string]any{"projectId": "project-1", "name": "demo"}},
				"revision": map[string]any{"projectId": "project-1", "revision": "8", "specHash": "sha256:candidate"},
				"changes":  []any{map[string]any{"action": "PROJECT_CHANGE_ACTION_UPDATED", "resourceType": "project_agent", "name": "worker"}},
				"issues":   []any{}, "applied": !boolValue(body["dryRun"]),
			})
		default:
			t.Fatalf("unexpected backend path %s", r.URL.Path)
		}
	}))
	defer backend.Close()

	handler := New(mustURL(t, backend.URL))
	preview := performJSON(t, handler, http.MethodPost, "/api/ui/v1/project-deployment-previews", map[string]any{
		"kind": "update_agent", "projectId": "project-1", "baseSpecHash": "sha256:base", "agentName": "worker",
		"agent": map[string]any{"provider": "codex", "model": "next-model", "displayName": "Updated worker", "enabled": true},
	}, "local:admin")
	if preview.Code != http.StatusCreated {
		t.Fatalf("preview = %d: %s", preview.Code, preview.Body.String())
	}
	var previewBody PreviewResponse
	if err := json.Unmarshal(preview.Body.Bytes(), &previewBody); err != nil {
		t.Fatal(err)
	}
	if !previewBody.Deployable || previewBody.PreviewID == "" {
		t.Fatalf("preview = %#v", previewBody)
	}
	if len(applyBodies) != 1 || !boolValue(applyBodies[0]["dryRun"]) {
		t.Fatalf("dry run bodies = %#v", applyBodies)
	}
	assertCandidatePreserved(t, objectValue(applyBodies[0]["spec"]))
	if stringValue(objectValue(applyBodies[0]["source"])["composePath"]) != "/srv/demo/compose.yaml" {
		t.Fatalf("source = %#v", applyBodies[0]["source"])
	}

	applied := performJSON(t, handler, http.MethodPost, "/api/ui/v1/project-deployment-previews/"+previewBody.PreviewID+"/apply", nil, "local:admin")
	if applied.Code != http.StatusOK {
		t.Fatalf("apply = %d: %s", applied.Code, applied.Body.String())
	}
	if len(applyBodies) != 2 || boolValue(applyBodies[1]["dryRun"]) || stringValue(applyBodies[1]["expectedSpecHash"]) != "sha256:candidate" {
		t.Fatalf("apply bodies = %#v", applyBodies)
	}
	assertCandidatePreserved(t, objectValue(applyBodies[1]["spec"]))

	reused := performJSON(t, handler, http.MethodPost, "/api/ui/v1/project-deployment-previews/"+previewBody.PreviewID+"/apply", nil, "local:admin")
	if reused.Code != http.StatusGone {
		t.Fatalf("reused preview = %d: %s", reused.Code, reused.Body.String())
	}
}

func TestListProjectsUsesTotalOffsetPagination(t *testing.T) {
	var offsets []int
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch r.URL.Path {
		case "/agentcompose.v2.ProjectService/ListProjects":
			offset := intValue(body["offset"])
			offsets = append(offsets, offset)
			projects := []any{
				map[string]any{"projectId": "project-1", "name": "One"},
				map[string]any{"projectId": "project-2", "name": "Two"},
			}
			if offset == 2 {
				projects = []any{map[string]any{"projectId": "project-3", "name": "Three"}}
			}
			writeJSON(w, http.StatusOK, map[string]any{"projects": projects, "total": 3})
		case "/agentcompose.v2.ProjectService/GetProject":
			projectID := stringValue(objectValue(body["project"])["projectId"])
			writeJSON(w, http.StatusOK, map[string]any{"project": map[string]any{
				"summary": map[string]any{
					"projectId": projectID, "name": projectID, "currentRevision": "1", "specHash": "hash-" + projectID,
				},
				"spec": map[string]any{"name": projectID, "agents": []any{}}, "agents": []any{},
			}})
		default:
			t.Fatalf("unexpected backend path %s", r.URL.Path)
		}
	}))
	defer backend.Close()

	response := performJSON(t, New(mustURL(t, backend.URL)), http.MethodGet, "/api/ui/v1/projects", nil, "local:admin")
	if response.Code != http.StatusOK {
		t.Fatalf("projects = %d: %s", response.Code, response.Body.String())
	}
	var body struct {
		Projects []ProjectView `json:"projects"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Projects) != 3 || len(offsets) != 2 || offsets[0] != 0 || offsets[1] != 2 {
		t.Fatalf("projects = %d, offsets = %#v", len(body.Projects), offsets)
	}
}

func TestPreviewBlocksRedactedProjects(t *testing.T) {
	applyCalls := 0
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/agentcompose.v2.ProjectService/GetProject":
			writeJSON(w, http.StatusOK, projectFixture(true))
		case "/agentcompose.v2.ProjectService/ApplyProject":
			applyCalls++
		default:
			t.Fatalf("unexpected backend path %s", r.URL.Path)
		}
	}))
	defer backend.Close()

	handler := New(mustURL(t, backend.URL))
	response := performJSON(t, handler, http.MethodPost, "/api/ui/v1/project-deployment-previews", map[string]any{
		"kind": "delete_agent", "projectId": "project-1", "agentName": "worker",
	}, "local:admin")
	if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), "脱敏凭据") {
		t.Fatalf("response = %d: %s", response.Code, response.Body.String())
	}
	if applyCalls != 0 {
		t.Fatalf("apply calls = %d", applyCalls)
	}
}

func TestSchedulerPreviewOnlyReplacesTargetScheduler(t *testing.T) {
	var dryRunSpec map[string]any
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch r.URL.Path {
		case "/agentcompose.v2.ProjectService/GetProject":
			writeJSON(w, http.StatusOK, projectFixture(false))
		case "/agentcompose.v2.ProjectService/ApplyProject":
			dryRunSpec = objectValue(body["spec"])
			writeJSON(w, http.StatusOK, map[string]any{
				"revision": map[string]any{"projectId": "project-1", "specHash": "sha256:scheduler"},
				"changes":  []any{}, "issues": []any{}, "applied": false,
			})
		default:
			t.Fatalf("unexpected backend path %s", r.URL.Path)
		}
	}))
	defer backend.Close()

	response := performJSON(t, New(mustURL(t, backend.URL)), http.MethodPost, "/api/ui/v1/project-deployment-previews", map[string]any{
		"kind": "update_scheduler", "projectId": "project-1", "baseSpecHash": "sha256:base", "agentName": "worker",
		"agent": map[string]any{"env": []any{
			map[string]any{"name": "REGION", "value": "cn", "secret": false, "unknown": "discard"},
		}},
		"scheduler": map[string]any{
			"enabled": true, "displayName": "Nightly", "description": "nightly checks", "script": "scheduler.cron('nightly', '0 0 * * *', function () {})",
			"sandboxPolicy": "sticky", "concurrencyPolicy": "skip", "unknown": "discard",
		},
	}, "local:admin")
	if response.Code != http.StatusCreated {
		t.Fatalf("preview = %d: %s", response.Code, response.Body.String())
	}
	var preview PreviewResponse
	_ = json.Unmarshal(response.Body.Bytes(), &preview)
	if !preview.Deployable || len(preview.Changes) != 3 || stringValue(preview.Changes[0]["resourceType"]) != "project_scheduler" {
		t.Fatalf("preview = %#v", preview)
	}
	agents := arrayValue(dryRunSpec["agents"])
	worker := objectValue(agents[0])
	scheduler := objectValue(worker["scheduler"])
	if stringValue(scheduler["displayName"]) != "Nightly" || scheduler["unknown"] != nil {
		t.Fatalf("scheduler = %#v", scheduler)
	}
	if stringValue(scheduler["sandboxPolicy"]) != "SCHEDULER_SANDBOX_POLICY_STICKY" ||
		stringValue(scheduler["concurrencyPolicy"]) != "SCHEDULER_CONCURRENCY_POLICY_SKIP" {
		t.Fatalf("scheduler policies = %#v", scheduler)
	}
	env := objectValue(arrayValue(worker["env"])[0])
	if stringValue(env["name"]) != "REGION" || stringValue(env["value"]) != "cn" || env["unknown"] != nil {
		t.Fatalf("env = %#v", env)
	}
	if worker["jupyter"] == nil || worker["build"] == nil || len(arrayValue(worker["mcpServers"])) != 1 {
		t.Fatalf("worker fields were not preserved: %#v", worker)
	}
	if stringValue(objectValue(agents[1])["customFutureField"]) != "keep" {
		t.Fatalf("sibling = %#v", agents[1])
	}
}

func TestPreviewNormalizesCurrentDaemonProjectSpec(t *testing.T) {
	var candidate map[string]any
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch r.URL.Path {
		case "/agentcompose.v2.ProjectService/GetProject":
			fixture := projectFixture(false)
			worker := objectValue(arrayValue(objectValue(objectValue(fixture["project"])["spec"])["agents"])[0])
			worker["driver"] = map[string]any{"name": "docker"}
			writeJSON(w, http.StatusOK, fixture)
		case "/agentcompose.v2.ProjectService/ApplyProject":
			candidate = objectValue(body["spec"])
			writeJSON(w, http.StatusOK, map[string]any{
				"revision": map[string]any{"projectId": "project-1", "specHash": "sha256:normalized"},
				"issues":   []any{}, "changes": []any{},
			})
		default:
			t.Fatalf("unexpected backend path %s", r.URL.Path)
		}
	}))
	defer backend.Close()

	response := performJSON(t, New(mustURL(t, backend.URL)), http.MethodPost, "/api/ui/v1/project-deployment-previews", map[string]any{
		"kind": "create_scheduler", "projectId": "project-1", "agentName": "sibling",
		"agent": map[string]any{"env": []any{}},
		"scheduler": map[string]any{
			"enabled": true, "script": "scheduler.on('x', 'y', function () {})",
			"sandboxPolicy": "new", "concurrencyPolicy": "parallel",
			"triggers": []any{map[string]any{"kind": "event", "sandboxPolicy": "sticky"}},
		},
	}, "local:admin")
	if response.Code != http.StatusCreated {
		t.Fatalf("preview = %d: %s", response.Code, response.Body.String())
	}

	worker := objectValue(arrayValue(candidate["agents"])[0])
	if objectValue(objectValue(worker["driver"])["docker"]) == nil {
		t.Fatalf("driver = %#v", worker["driver"])
	}
	scheduler := objectValue(objectValue(arrayValue(candidate["agents"])[1])["scheduler"])
	if stringValue(scheduler["sandboxPolicy"]) != "SCHEDULER_SANDBOX_POLICY_NEW" ||
		stringValue(scheduler["concurrencyPolicy"]) != "SCHEDULER_CONCURRENCY_POLICY_PARALLEL" {
		t.Fatalf("scheduler = %#v", scheduler)
	}
	trigger := objectValue(arrayValue(scheduler["triggers"])[0])
	if stringValue(trigger["kind"]) != "TRIGGER_KIND_EVENT" ||
		stringValue(trigger["sandboxPolicy"]) != "SCHEDULER_SANDBOX_POLICY_STICKY" {
		t.Fatalf("trigger = %#v", trigger)
	}
}

func TestProjectVariablePreviewOnlyReplacesVariables(t *testing.T) {
	var dryRunSpec map[string]any
	applyCalls := 0
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch r.URL.Path {
		case "/agentcompose.v2.ProjectService/GetProject":
			writeJSON(w, http.StatusOK, projectFixture(false))
		case "/agentcompose.v2.ProjectService/ApplyProject":
			applyCalls++
			dryRunSpec = objectValue(body["spec"])
			writeJSON(w, http.StatusOK, map[string]any{
				"revision": map[string]any{"projectId": "project-1", "specHash": "sha256:variables"},
				"changes":  []any{}, "issues": []any{}, "applied": false,
			})
		default:
			t.Fatalf("unexpected backend path %s", r.URL.Path)
		}
	}))
	defer backend.Close()

	handler := New(mustURL(t, backend.URL))
	response := performJSON(t, handler, http.MethodPost, "/api/ui/v1/project-deployment-previews", map[string]any{
		"kind": "update_project_variables", "projectId": "project-1", "baseSpecHash": "sha256:base",
		"variables": []any{
			map[string]any{"name": " REGION ", "value": "cn", "secret": false, "unknown": "discard"},
			map[string]any{"name": "TOKEN", "value": "value", "secret": true},
		},
	}, "local:admin")
	if response.Code != http.StatusCreated {
		t.Fatalf("preview = %d: %s", response.Code, response.Body.String())
	}
	var preview PreviewResponse
	_ = json.Unmarshal(response.Body.Bytes(), &preview)
	if !preview.Deployable || len(preview.Changes) != 1 || stringValue(preview.Changes[0]["resourceType"]) != "project" {
		t.Fatalf("preview = %#v", preview)
	}
	variables := arrayValue(dryRunSpec["variables"])
	if len(variables) != 2 || stringValue(objectValue(variables[0])["name"]) != "REGION" || objectValue(variables[0])["unknown"] != nil {
		t.Fatalf("variables = %#v", variables)
	}
	if len(arrayValue(dryRunSpec["agents"])) != 2 {
		t.Fatalf("agents were not preserved: %#v", dryRunSpec["agents"])
	}

	invalid := performJSON(t, handler, http.MethodPost, "/api/ui/v1/project-deployment-previews", map[string]any{
		"kind": "update_project_variables", "projectId": "project-1",
		"variables": []any{
			map[string]any{"name": "TOKEN", "value": "one"},
			map[string]any{"name": "TOKEN", "value": "two"},
		},
	}, "local:admin")
	if invalid.Code != http.StatusBadRequest || !strings.Contains(invalid.Body.String(), "名称重复") {
		t.Fatalf("invalid = %d: %s", invalid.Code, invalid.Body.String())
	}
	if applyCalls != 1 {
		t.Fatalf("apply calls = %d", applyCalls)
	}
}

func TestPreviewDisablesUnchangedProject(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/agentcompose.v2.ProjectService/GetProject":
			writeJSON(w, http.StatusOK, projectFixture(false))
		case "/agentcompose.v2.ProjectService/ApplyProject":
			writeJSON(w, http.StatusOK, map[string]any{
				"revision": map[string]any{"projectId": "project-1", "specHash": "sha256:base"},
				"changes":  []any{map[string]any{"action": "PROJECT_CHANGE_ACTION_CREATED", "resourceType": "project"}},
				"issues":   []any{}, "applied": false,
			})
		default:
			t.Fatalf("unexpected backend path %s", r.URL.Path)
		}
	}))
	defer backend.Close()

	response := performJSON(t, New(mustURL(t, backend.URL)), http.MethodPost, "/api/ui/v1/project-deployment-previews", map[string]any{
		"kind": "update_agent", "projectId": "project-1", "baseSpecHash": "sha256:base", "agentName": "worker",
		"agent": map[string]any{"provider": "codex", "model": "old-model", "displayName": "Worker", "enabled": true},
	}, "local:admin")
	if response.Code != http.StatusCreated {
		t.Fatalf("preview = %d: %s", response.Code, response.Body.String())
	}
	var preview PreviewResponse
	_ = json.Unmarshal(response.Body.Bytes(), &preview)
	if preview.Deployable || len(preview.Changes) != 0 {
		t.Fatalf("unchanged preview = %#v", preview)
	}
}

func TestApplyRejectsAnotherActorAndChangedProject(t *testing.T) {
	hash := "sha256:base"
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch r.URL.Path {
		case "/agentcompose.v2.ProjectService/GetProject":
			fixture := projectFixture(false)
			objectValue(objectValue(fixture["project"])["summary"])["specHash"] = hash
			writeJSON(w, http.StatusOK, fixture)
		case "/agentcompose.v2.ProjectService/ApplyProject":
			writeJSON(w, http.StatusOK, map[string]any{
				"revision": map[string]any{"projectId": "project-1", "specHash": "sha256:candidate"},
				"changes":  []any{}, "issues": []any{}, "applied": false,
			})
		default:
			t.Fatalf("unexpected backend path %s", r.URL.Path)
		}
	}))
	defer backend.Close()

	handler := New(mustURL(t, backend.URL))
	preview := performJSON(t, handler, http.MethodPost, "/api/ui/v1/project-deployment-previews", map[string]any{
		"kind": "delete_agent", "projectId": "project-1", "baseSpecHash": hash, "agentName": "worker",
	}, "local:admin")
	var body PreviewResponse
	_ = json.Unmarshal(preview.Body.Bytes(), &body)

	forbidden := performJSON(t, handler, http.MethodPost, "/api/ui/v1/project-deployment-previews/"+body.PreviewID+"/apply", nil, "local:other")
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("forbidden = %d: %s", forbidden.Code, forbidden.Body.String())
	}
	hash = "sha256:changed"
	conflict := performJSON(t, handler, http.MethodPost, "/api/ui/v1/project-deployment-previews/"+body.PreviewID+"/apply", nil, "local:admin")
	if conflict.Code != http.StatusConflict {
		t.Fatalf("conflict = %d: %s", conflict.Code, conflict.Body.String())
	}
}

func projectFixture(redacted bool) map[string]any {
	envValue := "public"
	if redacted {
		envValue = redactedSecret
	}
	return map[string]any{"project": map[string]any{
		"summary": map[string]any{
			"projectId": "project-1", "name": "demo", "sourcePath": "/srv/demo/compose.yaml",
			"currentRevision": "7", "specHash": "sha256:base", "agentCount": 2, "schedulerCount": 1,
		},
		"spec": map[string]any{
			"name": "demo", "variables": []any{map[string]any{"name": "TOKEN", "value": envValue, "secret": redacted}},
			"agents": []any{
				map[string]any{
					"name": "worker", "provider": "codex", "model": "old-model", "displayName": "Worker",
					"scheduler": map[string]any{"enabled": true, "script": "scheduler.on('x', 'y', function () {})"},
					"jupyter":   map[string]any{"enabled": true}, "mcpServers": []any{map[string]any{"name": "docs"}},
					"skills": []any{map[string]any{"name": "review"}}, "volumes": []any{map[string]any{"source": "cache"}},
					"build": map[string]any{"context": "."},
				},
				map[string]any{"name": "sibling", "provider": "codex", "model": "sibling-model", "customFutureField": "keep"},
			},
		},
		"agents": []any{
			map[string]any{"managedAgentId": "agent-worker", "agentName": "worker", "schedulerEnabled": true},
			map[string]any{"managedAgentId": "agent-sibling", "agentName": "sibling"},
		},
	}}
}

func assertCandidatePreserved(t *testing.T, spec map[string]any) {
	t.Helper()
	agents := arrayValue(spec["agents"])
	worker := objectValue(agents[0])
	if stringValue(worker["model"]) != "next-model" || worker["scheduler"] == nil || worker["jupyter"] == nil ||
		len(arrayValue(worker["mcpServers"])) != 1 || len(arrayValue(worker["skills"])) != 1 ||
		len(arrayValue(worker["volumes"])) != 1 || worker["build"] == nil {
		t.Fatalf("worker candidate = %#v", worker)
	}
	sibling := objectValue(agents[1])
	if stringValue(sibling["customFutureField"]) != "keep" || stringValue(sibling["model"]) != "sibling-model" {
		t.Fatalf("sibling candidate = %#v", sibling)
	}
}

func performJSON(t *testing.T, handler http.Handler, method, path string, body any, actorID string) *httptest.ResponseRecorder {
	t.Helper()
	var raw string
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		raw = string(data)
	}
	request := httptest.NewRequest(method, path, strings.NewReader(raw))
	request = request.WithContext(audit.WithPrincipal(context.Background(), audit.Principal{ID: actorID}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func mustURL(t *testing.T, value string) *url.URL {
	t.Helper()
	result, err := url.Parse(value)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
