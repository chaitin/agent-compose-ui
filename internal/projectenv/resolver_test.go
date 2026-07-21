package projectenv

import (
	"reflect"
	"testing"
)

func TestResolveSpecValues(t *testing.T) {
	spec := map[string]any{
		"variables": []any{
			map[string]any{"name": "LITERAL", "value": "production"},
			map[string]any{"name": "EXACT", "value": "${TOKEN}"},
			map[string]any{"name": "MIXED", "value": "Bearer ${TOKEN}"},
			map[string]any{"name": "MULTIPLE", "value": "${HOST}:${PORT}"},
			map[string]any{"name": "UNKNOWN", "value": "${DAEMON_ONLY}"},
		},
		"agents": []any{
			map[string]any{
				"name":      "worker",
				"model":     "${MODEL}",
				"build":     map[string]any{"args": map[string]any{"endpoint": "https://${HOST}/build"}},
				"volumes":   []any{map[string]any{"source": "${VOLUME_PATH}"}},
				"scheduler": map[string]any{"script": "const known = `${SCRIPT_KNOWN}`;\nconst missing = `${SCRIPT_ONLY}`;\n"},
				"env":       []any{map[string]any{"name": "AGENT_TOKEN", "value": "${TOKEN}"}},
				"mcps": []any{map[string]any{
					"name":    "remote",
					"headers": []any{map[string]any{"name": "Authorization", "value": "Bearer ${TOKEN}"}},
				}},
			},
		},
		"mcps": []any{map[string]any{
			"name": "local",
			"env":  []any{map[string]any{"name": "MCP_TOKEN", "value": "${PLAIN}"}},
		}},
	}

	result, err := ResolveSpec(spec, map[string]GlobalValue{
		"TOKEN":        {Value: "secret-value", Secret: true},
		"HOST":         {Value: "api.example.test"},
		"PORT":         {Value: "443"},
		"PLAIN":        {Value: "visible"},
		"MODEL":        {Value: "claude-test"},
		"VOLUME_PATH":  {Value: "/srv/data"},
		"SCRIPT_KNOWN": {Value: "must-not-appear"},
	})
	if err != nil {
		t.Fatalf("ResolveSpec returned error: %v", err)
	}

	variables := envByName(t, result.Spec["variables"])
	if got := variables["LITERAL"]["value"]; got != "production" {
		t.Fatalf("literal value = %#v", got)
	}
	if got := variables["EXACT"]["value"]; got != "secret-value" {
		t.Fatalf("exact value = %#v", got)
	}
	if got := variables["MIXED"]["value"]; got != "Bearer secret-value" {
		t.Fatalf("mixed value = %#v", got)
	}
	if got := variables["MULTIPLE"]["value"]; got != "api.example.test:443" {
		t.Fatalf("multiple value = %#v", got)
	}
	if got := variables["UNKNOWN"]["value"]; got != "${DAEMON_ONLY}" {
		t.Fatalf("unknown value = %#v", got)
	}
	for _, name := range []string{"EXACT", "MIXED"} {
		if got := variables[name]["secret"]; got != true {
			t.Fatalf("%s secret = %#v", name, got)
		}
	}
	if len(result.Warnings) != 1 || result.Warnings[0].Name != "DAEMON_ONLY" || result.Warnings[0].Path != "variables.UNKNOWN.value" {
		t.Fatalf("warnings = %#v", result.Warnings)
	}
	wantReferences := []string{"HOST", "MODEL", "PLAIN", "PORT", "TOKEN", "VOLUME_PATH"}
	if !reflect.DeepEqual(result.References, wantReferences) {
		t.Fatalf("references = %#v, want %#v", result.References, wantReferences)
	}

	agents := result.Spec["agents"].([]any)
	agent := agents[0].(map[string]any)
	if got := agent["model"]; got != "claude-test" {
		t.Fatalf("agent model = %#v", got)
	}
	if got := agent["build"].(map[string]any)["args"].(map[string]any)["endpoint"]; got != "https://api.example.test/build" {
		t.Fatalf("build endpoint = %#v", got)
	}
	if got := agent["volumes"].([]any)[0].(map[string]any)["source"]; got != "/srv/data" {
		t.Fatalf("volume source = %#v", got)
	}
	wantScript := "const known = `${SCRIPT_KNOWN}`;\nconst missing = `${SCRIPT_ONLY}`;\n"
	if got := agent["scheduler"].(map[string]any)["script"]; got != wantScript {
		t.Fatalf("scheduler script = %#v, want %#v", got, wantScript)
	}
	if got := envByName(t, agent["env"])["AGENT_TOKEN"]["secret"]; got != true {
		t.Fatalf("agent secret = %#v", got)
	}
	projectMCP := result.Spec["mcps"].([]any)[0].(map[string]any)
	if got := envByName(t, projectMCP["env"])["MCP_TOKEN"]["value"]; got != "visible" {
		t.Fatalf("project MCP value = %#v", got)
	}
	agentMCP := agent["mcps"].([]any)[0].(map[string]any)
	if got := envByName(t, agentMCP["headers"])["Authorization"]["value"]; got != "Bearer secret-value" {
		t.Fatalf("agent MCP header = %#v", got)
	}
}

func TestResolveSpecDoesNotMutateInput(t *testing.T) {
	spec := map[string]any{"variables": []any{map[string]any{"name": "TOKEN", "value": "${TOKEN}"}}}
	_, err := ResolveSpec(spec, map[string]GlobalValue{"TOKEN": {Value: "resolved", Secret: true}})
	if err != nil {
		t.Fatal(err)
	}
	if got := envByName(t, spec["variables"])["TOKEN"]["value"]; got != "${TOKEN}" {
		t.Fatalf("input mutated to %#v", got)
	}
}

func envByName(t *testing.T, value any) map[string]map[string]any {
	t.Helper()
	items, ok := value.([]any)
	if !ok {
		t.Fatalf("env value = %T, want []any", value)
	}
	result := make(map[string]map[string]any, len(items))
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("env item = %T, want map[string]any", raw)
		}
		name, _ := item["name"].(string)
		result[name] = item
	}
	return result
}
