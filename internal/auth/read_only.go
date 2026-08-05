package auth

import (
	"net/http"
	"strings"
)

var readOnlyProcedures = map[string]struct{}{
	"/agentcompose.v2.ProjectService/GetProject":                   {},
	"/agentcompose.v2.ProjectService/ListProjects":                 {},
	"/agentcompose.v2.ProjectService/WatchProject":                 {},
	"/agentcompose.v2.ProjectService/GetScheduler":                 {},
	"/agentcompose.v2.ProjectService/ListSchedulers":               {},
	"/agentcompose.v2.ProjectService/ListSchedulerEvents":          {},
	"/agentcompose.v2.ProjectService/ListProjectSchedulerEvents":   {},
	"/agentcompose.v2.ProjectService/StreamProjectSchedulerEvents": {},
	"/agentcompose.v2.ProjectService/GetSchedulerRun":              {},
	"/agentcompose.v2.ProjectService/ListSchedulerRuns":            {},
	"/agentcompose.v2.ProjectService/BatchGetLatestSchedulerRuns":  {},
	"/agentcompose.v2.ProjectService/StreamSchedulerRuns":          {},
	"/agentcompose.v2.RunService/GetRun":                           {},
	"/agentcompose.v2.RunService/ListRuns":                         {},
	"/agentcompose.v2.RunService/FollowRunLogs":                    {},
	"/agentcompose.v2.RunService/ListRunEvents":                    {},
	"/agentcompose.v2.RunService/ListSandboxRunEvents":             {},
	"/agentcompose.v2.ImageService/ListImages":                     {},
	"/agentcompose.v2.ImageService/InspectImage":                   {},
	"/agentcompose.v2.CacheService/ListCaches":                     {},
	"/agentcompose.v2.CacheService/InspectCache":                   {},
	"/agentcompose.v2.VolumeService/ListVolumes":                   {},
	"/agentcompose.v2.VolumeService/InspectVolume":                 {},
	"/agentcompose.v2.SandboxService/GetSandboxStats":              {},
	"/agentcompose.v2.SandboxService/GetSandbox":                   {},
	"/agentcompose.v2.SandboxService/ListSandboxes":                {},
	"/agentcompose.v2.SandboxService/ListSandboxHistory":           {},
	"/agentcompose.v2.SandboxService/WatchSandbox":                 {},
	"/agentcompose.v2.DashboardService/GetDashboardOverview":       {},
	"/agentcompose.v2.DashboardService/WatchDashboardOverview":     {},
	"/agentcompose.v2.SettingsService/GetGlobalEnv":                {},
	"/agentcompose.v2.SettingsService/GetCapabilityGatewayConfig":  {},
	"/agentcompose.v2.SettingsService/ListWorkspacePresets":        {},
	"/agentcompose.v2.CapabilityService/GetCapabilityStatus":       {},
	"/agentcompose.v2.CapabilityService/ListCapabilitySets":        {},
	"/agentcompose.v2.CapabilityService/GetCapabilityCatalog":      {},
	"/agentcompose.v2.ResourceService/ResolveID":                   {},
	"/health.v1.HealthService/Status":                              {},
	"/health.v1.HealthService/WatchStatus":                         {},
}

func isReadOnlyRequest(r *http.Request) bool {
	if r.URL.RawPath != "" {
		return false
	}
	if r.Method == http.MethodPost {
		_, ok := readOnlyProcedures[r.URL.Path]
		return ok
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	return isReadOnlyRESTPath(r.URL.Path) || isReadOnlyUIPath(r.URL.Path)
}

func isReadOnlyUIPath(path string) bool {
	if path == "/api/ui/v1/projects" || path == "/api/ui/v1/runs/unlinked" || path == "/api/ui/v1/tokens" {
		return true
	}
	if path == "/api/ui/v1/audit/events" || path == "/api/ui/v1/audit/export" {
		return true
	}
	if strings.HasPrefix(path, "/api/ui/v1/projects/") {
		segments := strings.Split(strings.TrimPrefix(path, "/api/ui/v1/projects/"), "/")
		return (len(segments) == 1 && segments[0] != "") ||
			(len(segments) == 2 && segments[0] != "" && segments[1] == "yaml")
	}
	const sandboxPrefix = "/api/ui/v1/sandboxes/"
	if strings.HasPrefix(path, sandboxPrefix) {
		segments := strings.Split(strings.TrimPrefix(path, sandboxPrefix), "/")
		return len(segments) >= 2 && segments[0] != "" && segments[1] == "agent-records"
	}
	return false
}

func isReadOnlyRESTPath(path string) bool {
	if path == "/api/version" || path == "/api/webhook-sources" || path == "/api/events" || path == "/api/events/topics" {
		return true
	}
	if strings.HasPrefix(path, "/api/events/") {
		segments := strings.Split(strings.TrimPrefix(path, "/api/events/"), "/")
		return (len(segments) == 1 && segments[0] != "") ||
			(len(segments) == 2 && segments[0] != "" && (segments[1] == "sessions" || segments[1] == "sandboxes" || segments[1] == "runs" || segments[1] == "trace"))
	}
	const workspacePrefix = "/api/agent-compose/workspaces/"
	if strings.HasPrefix(path, workspacePrefix) {
		segments := strings.Split(strings.TrimPrefix(path, workspacePrefix), "/")
		return len(segments) == 2 && segments[0] != "" && (segments[1] == "files" || segments[1] == "download")
	}
	return false
}
