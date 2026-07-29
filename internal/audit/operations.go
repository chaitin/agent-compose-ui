package audit

import (
	"bytes"
	"encoding/binary"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"
)

const maxInspectBody = 8 << 20

type operation struct {
	Category     string
	Action       string
	ResourceType string
	ResourceID   string
}

func inspectOperation(r *http.Request) (operation, bool) {
	path := r.URL.Path
	if path == "/api/auth/status" {
		return operation{}, false
	}
	if strings.HasPrefix(path, "/agentcompose.") || strings.HasPrefix(path, "/health.v1.") {
		name := path[strings.LastIndex(path, "/")+1:]
		if isReadOperation(name) {
			return operation{}, false
		}
		body := inspectRequestBody(r)
		resourceType, resourceID := connectResource(path, body)
		return operation{Category: categoryForPath(path), Action: name, ResourceType: resourceType, ResourceID: resourceID}, true
	}
	if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
		return operation{}, false
	}
	resourceType, resourceID := restResource(path)
	return operation{Category: categoryForPath(path), Action: r.Method + " " + path, ResourceType: resourceType, ResourceID: resourceID}, true
}

func isReadOperation(name string) bool {
	for _, prefix := range []string{"Get", "List", "Watch", "Inspect", "Resolve", "Follow", "Stream", "BatchGet", "Validate", "Status"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

func inspectRequestBody(r *http.Request) []byte {
	if r.Body == nil {
		return nil
	}
	limited := io.LimitReader(r.Body, maxInspectBody+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil
	}
	r.Body = io.NopCloser(io.MultiReader(bytes.NewReader(data), r.Body))
	if len(data) > maxInspectBody {
		return nil
	}
	if len(data) >= 5 {
		length := int(binary.BigEndian.Uint32(data[1:5]))
		if length >= 0 && 5+length <= len(data) {
			return data[5 : 5+length]
		}
	}
	return data
}

// connectResource uses an operation whitelist. A protobuf field number alone
// is not sufficient: field 1 is an ID in some requests and a nested spec
// (which may contain secrets) in others.
func connectResource(path string, body []byte) (string, string) {
	name := path[strings.LastIndex(path, "/")+1:]
	switch {
	case name == "StartRun":
		return runAgentResource(protoBytes(body, 1))
	case name == "RunAgent", name == "RunAgentStream":
		return runAgentResource(body)
	case name == "StopRun":
		return "run", protoString(body, 1)
	case name == "RemoveSandbox", name == "StopSandbox", name == "ResumeSandbox":
		return "sandbox", protoString(body, 1)
	case name == "PruneSandboxes":
		return "project", protoString(body, 1)
	case name == "PullImage", name == "RemoveImage":
		return "image", protoString(body, 1)
	case name == "RemoveCache":
		return "cache", protoString(body, 1)
	case name == "CreateVolume", name == "RemoveVolume":
		return "volume", protoString(body, 1)
	case name == "PruneVolumes":
		return "project", protoString(body, 3)
	case name == "UpdateWorkspacePreset", name == "DeleteWorkspacePreset":
		return "workspace_preset", protoString(body, 1)
	case name == "StopSchedulerRun":
		return "scheduler_run", protoString(body, 2)
	case name == "InvokeScheduler", name == "StartSchedulerRun", name == "PruneSchedulerRuns",
		name == "SetSchedulerEnabled", name == "SetSchedulerTriggerEnabled":
		return projectRefResource(protoBytes(body, 1))
	case name == "ApplyProject":
		if spec := protoBytes(body, 1); len(spec) > 0 {
			return "project", protoString(spec, 1)
		}
	case name == "RemoveProject":
		return projectRefResource(protoBytes(body, 1))
	}
	return "", ""
}

func runAgentResource(body []byte) (string, string) {
	if value := protoString(body, 15); value != "" {
		return "sandbox", value
	}
	if value := protoString(body, 1); value != "" {
		return "project", value
	}
	return "", ""
}

func projectRefResource(ref []byte) (string, string) {
	if value := protoString(ref, 1); value != "" {
		return "project", value
	}
	return "project", protoString(ref, 2)
}

func protoString(data []byte, wanted int) string {
	value := string(protoBytes(data, wanted))
	if !safeResourceID(value) {
		return ""
	}
	return value
}

func safeResourceID(value string) bool {
	if value == "" || len(value) > 256 || !utf8.ValidString(value) {
		return false
	}
	for _, current := range value {
		if (current >= 'a' && current <= 'z') || (current >= 'A' && current <= 'Z') ||
			(current >= '0' && current <= '9') || strings.ContainsRune("-_.:/@+", current) {
			continue
		}
		return false
	}
	return true
}

func protoBytes(data []byte, wanted int) []byte {
	for len(data) > 0 {
		tag, n := consumeVarint(data)
		if n <= 0 {
			return nil
		}
		data = data[n:]
		field, wire := int(tag>>3), int(tag&7)
		switch wire {
		case 0:
			_, n = consumeVarint(data)
			if n <= 0 {
				return nil
			}
			data = data[n:]
		case 1:
			if len(data) < 8 {
				return nil
			}
			data = data[8:]
		case 2:
			length, size := consumeVarint(data)
			if size <= 0 || length > uint64(len(data)-size) {
				return nil
			}
			value := data[size : size+int(length)]
			if field == wanted {
				return value
			}
			data = data[size+int(length):]
		case 5:
			if len(data) < 4 {
				return nil
			}
			data = data[4:]
		default:
			return nil
		}
	}
	return nil
}

func consumeVarint(data []byte) (uint64, int) {
	var value uint64
	for index, current := range data {
		if index >= 10 {
			return 0, -1
		}
		value |= uint64(current&0x7f) << (7 * index)
		if current < 0x80 {
			return value, index + 1
		}
	}
	return 0, -1
}

func restResource(path string) (string, string) {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) >= 4 && parts[0] == "api" && parts[1] == "ui" && parts[3] == "tokens" {
		if len(parts) > 4 {
			return "api_token", parts[4]
		}
		return "api_token", ""
	}
	if len(parts) >= 4 && parts[0] == "api" && parts[1] == "ui" && parts[3] == "projects" {
		if len(parts) > 4 {
			return "project", parts[4]
		}
		return "project", ""
	}
	if len(parts) >= 4 && parts[0] == "api" && parts[1] == "ui" && parts[3] == "project-deployment-previews" {
		if len(parts) > 4 {
			return "project_deployment_preview", parts[4]
		}
		return "project_deployment_preview", ""
	}
	if len(parts) >= 3 && parts[0] == "ui-api" && parts[2] == "tokens" {
		if len(parts) > 3 {
			return "api_token", parts[3]
		}
		return "api_token", ""
	}
	if len(parts) >= 3 && parts[0] == "api" && parts[1] == "events" {
		return "event", parts[2]
	}
	if len(parts) >= 3 && parts[0] == "api" && parts[1] == "webhooks" {
		return "webhook_source", parts[2]
	}
	if len(parts) >= 3 && parts[0] == "api" && parts[1] == "webhook-sources" {
		return "webhook_source", parts[2]
	}
	return "", ""
}

func categoryForPath(path string) string {
	for _, item := range []struct{ needle, category string }{
		{"ProjectService", "project"}, {"RunService", "run"}, {"SandboxService", "sandbox"},
		{"Scheduler", "automation"}, {"ImageService", "image"}, {"CacheService", "cache"},
		{"SettingsService", "settings"}, {"Capability", "capability"}, {"/tokens", "token"},
		{"/api/ui/v1/projects", "project"}, {"/api/ui/v1/project-deployment", "project"},
		{"/api/webhook", "webhook"},
	} {
		if strings.Contains(path, item.needle) {
			return item.category
		}
	}
	return "system"
}
