package tokenproxy

import (
	"net/http"
	"strings"

	"agent-compose-ui/internal/apitoken"
)

var readOnlyProcedures = map[string]struct{}{
	"/agentcompose.v2.ProjectService/GetProject":                  {},
	"/agentcompose.v2.ProjectService/ListProjects":                {},
	"/agentcompose.v2.ProjectService/WatchProject":                {},
	"/agentcompose.v2.ProjectService/GetScheduler":                {},
	"/agentcompose.v2.ProjectService/ListSchedulers":              {},
	"/agentcompose.v2.ProjectService/ListSchedulerEvents":         {},
	"/agentcompose.v2.ProjectService/GetSchedulerRun":             {},
	"/agentcompose.v2.ProjectService/ListSchedulerRuns":           {},
	"/agentcompose.v2.RunService/GetRun":                          {},
	"/agentcompose.v2.RunService/ListRuns":                        {},
	"/agentcompose.v2.RunService/FollowRunLogs":                   {},
	"/agentcompose.v2.RunService/ListRunEvents":                   {},
	"/agentcompose.v2.RunService/ListSandboxRunEvents":            {},
	"/agentcompose.v2.ImageService/ListImages":                    {},
	"/agentcompose.v2.ImageService/InspectImage":                  {},
	"/agentcompose.v2.CacheService/ListCaches":                    {},
	"/agentcompose.v2.CacheService/InspectCache":                  {},
	"/agentcompose.v2.VolumeService/ListVolumes":                  {},
	"/agentcompose.v2.VolumeService/InspectVolume":                {},
	"/agentcompose.v2.SandboxService/GetSandboxStats":             {},
	"/agentcompose.v2.SandboxService/GetSandbox":                  {},
	"/agentcompose.v2.SandboxService/ListSandboxes":               {},
	"/agentcompose.v2.SandboxService/ListSandboxHistory":          {},
	"/agentcompose.v2.SandboxService/WatchSandbox":                {},
	"/agentcompose.v2.DashboardService/GetDashboardOverview":      {},
	"/agentcompose.v2.DashboardService/WatchDashboardOverview":    {},
	"/agentcompose.v2.SettingsService/GetGlobalEnv":               {},
	"/agentcompose.v2.SettingsService/GetCapabilityGatewayConfig": {},
	"/agentcompose.v2.SettingsService/ListWorkspacePresets":       {},
	"/agentcompose.v2.CapabilityService/GetCapabilityStatus":      {},
	"/agentcompose.v2.CapabilityService/ListCapabilitySets":       {},
	"/agentcompose.v2.CapabilityService/GetCapabilityCatalog":     {},
	"/agentcompose.v2.ResourceService/ResolveID":                  {},
	"/health.v1.HealthService/Status":                             {},
	"/health.v1.HealthService/WatchStatus":                        {},
}

func authorized(role apitoken.Role, r *http.Request) bool {
	if role == apitoken.RoleAdmin {
		return true
	}
	if role != apitoken.RoleReadOnlyAdmin || r.URL.RawPath != "" {
		return false
	}
	if r.Method == http.MethodPost {
		_, ok := readOnlyProcedures[r.URL.Path]
		return ok
	}
	if r.Method != http.MethodGet {
		return false
	}
	return readOnlyRESTPath(r.URL.Path)
}

func readOnlyRESTPath(path string) bool {
	if path == "/api/version" || path == "/api/webhook-sources" || path == "/api/events" {
		return true
	}
	if strings.HasPrefix(path, "/api/events/") {
		segments := strings.Split(strings.TrimPrefix(path, "/api/events/"), "/")
		return (len(segments) == 1 && segments[0] != "") ||
			len(segments) == 2 && segments[0] != "" && (segments[1] == "sessions" || segments[1] == "sandboxes" || segments[1] == "runs")
	}
	const workspacePrefix = "/api/agent-compose/workspaces/"
	if strings.HasPrefix(path, workspacePrefix) {
		segments := strings.Split(strings.TrimPrefix(path, workspacePrefix), "/")
		return len(segments) == 2 && segments[0] != "" && (segments[1] == "files" || segments[1] == "download")
	}
	return false
}
