package projectdeploy

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"

	"agent-compose-ui/internal/audit"
)

const (
	previewTTL            = 5 * time.Minute
	backendRequestTimeout = 2 * time.Minute
	redactedSecret        = "********"
	maxResponseBytes      = 32 << 20
)

type Handler struct {
	backend  *url.URL
	client   *http.Client
	now      func() time.Time
	mu       sync.Mutex
	previews map[string]previewRecord
	locks    map[string]*sync.Mutex
	mux      *http.ServeMux
}

type previewRecord struct {
	ID                string
	ActorID           string
	ProjectID         string
	ProjectName       string
	BaseSpecHash      string
	CandidateSpecHash string
	Candidate         map[string]any
	Source            map[string]any
	ExpiresAt         time.Time
	Used              bool
}

type MutationRequest struct {
	Kind         string         `json:"kind"`
	ProjectID    string         `json:"projectId,omitempty"`
	BaseSpecHash string         `json:"baseSpecHash,omitempty"`
	ProjectName  string         `json:"projectName,omitempty"`
	AgentName    string         `json:"agentName"`
	Variables    []any          `json:"variables,omitempty"`
	Agent        map[string]any `json:"agent,omitempty"`
	Scheduler    map[string]any `json:"scheduler,omitempty"`
}

type PreviewResponse struct {
	PreviewID         string           `json:"previewId"`
	ExpiresAt         time.Time        `json:"expiresAt"`
	ProjectID         string           `json:"projectId"`
	ProjectName       string           `json:"projectName"`
	BaseSpecHash      string           `json:"baseSpecHash,omitempty"`
	CandidateSpecHash string           `json:"candidateSpecHash"`
	Changes           []map[string]any `json:"changes"`
	Issues            []map[string]any `json:"issues"`
	Deployable        bool             `json:"deployable"`
	Mutation          MutationSummary  `json:"mutation"`
}

type MutationSummary struct {
	Kind      string `json:"kind"`
	AgentName string `json:"agentName"`
}

var editableSchedulerFields = map[string]struct{}{
	"enabled": {}, "triggers": {}, "script": {}, "sandboxPolicy": {}, "displayName": {}, "description": {},
	"concurrencyPolicy": {},
}

type ProjectView struct {
	ProjectID       string      `json:"projectId"`
	Name            string      `json:"name"`
	SourcePath      string      `json:"sourcePath,omitempty"`
	CurrentRevision string      `json:"currentRevision"`
	SpecHash        string      `json:"specHash"`
	AgentCount      int         `json:"agentCount"`
	SchedulerCount  int         `json:"schedulerCount"`
	RunningRunCount int         `json:"runningRunCount"`
	UpdatedAt       string      `json:"updatedAt,omitempty"`
	Editable        bool        `json:"editable"`
	BlockedReasons  []string    `json:"blockedReasons,omitempty"`
	Variables       []any       `json:"variables"`
	Agents          []AgentView `json:"agents"`
}

type AgentView struct {
	ID               string         `json:"id"`
	AgentName        string         `json:"agentName"`
	DisplayName      string         `json:"displayName"`
	Description      string         `json:"description,omitempty"`
	Enabled          bool           `json:"enabled"`
	Provider         string         `json:"provider"`
	Model            string         `json:"model"`
	SystemPrompt     string         `json:"systemPrompt,omitempty"`
	Image            string         `json:"image,omitempty"`
	Driver           map[string]any `json:"driver,omitempty"`
	Env              []any          `json:"env,omitempty"`
	Workspace        map[string]any `json:"workspace,omitempty"`
	CapsetIDs        []string       `json:"capsetIds,omitempty"`
	Availability     string         `json:"availability,omitempty"`
	Health           string         `json:"health,omitempty"`
	SchedulerEnabled bool           `json:"schedulerEnabled"`
	HasScheduler     bool           `json:"hasScheduler"`
	JupyterEnabled   bool           `json:"jupyterEnabled"`
	MCPCount         int            `json:"mcpCount"`
	SkillCount       int            `json:"skillCount"`
	VolumeCount      int            `json:"volumeCount"`
	HasBuild         bool           `json:"hasBuild"`
}

type listProjectsResponse struct {
	Projects []map[string]any `json:"projects"`
	Total    int              `json:"total"`
}

func New(backend *url.URL) *Handler {
	h := &Handler{
		backend:  backend,
		client:   &http.Client{Timeout: backendRequestTimeout},
		now:      time.Now,
		previews: make(map[string]previewRecord),
		locks:    make(map[string]*sync.Mutex),
		mux:      http.NewServeMux(),
	}
	h.mux.HandleFunc("GET /api/ui/v1/projects", h.listProjects)
	h.mux.HandleFunc("GET /api/ui/v1/projects/{projectID}", h.getProject)
	h.mux.HandleFunc("POST /api/ui/v1/project-deployment-previews", h.preview)
	h.mux.HandleFunc("POST /api/ui/v1/project-deployment-previews/{previewID}/apply", h.apply)
	return h
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) { h.mux.ServeHTTP(w, r) }

func (h *Handler) listProjects(w http.ResponseWriter, r *http.Request) {
	summaries, err := h.allProjectSummaries(r.Context())
	if err != nil {
		h.writeError(w, err)
		return
	}
	views := make([]ProjectView, 0, len(summaries))
	for _, summary := range summaries {
		project, err := h.loadProject(r.Context(), stringValue(summary["projectId"]))
		if err != nil {
			h.writeError(w, err)
			return
		}
		views = append(views, projectView(project))
	}
	sort.Slice(views, func(i, j int) bool { return strings.ToLower(views[i].Name) < strings.ToLower(views[j].Name) })
	writeJSON(w, http.StatusOK, map[string]any{"projects": views})
}

func (h *Handler) getProject(w http.ResponseWriter, r *http.Request) {
	project, err := h.loadProject(r.Context(), r.PathValue("projectID"))
	if err != nil {
		h.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"project": projectView(project)})
}

func (h *Handler) preview(w http.ResponseWriter, r *http.Request) {
	var input MutationRequest
	if err := decodeJSON(r, &input); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	input.Kind = strings.TrimSpace(input.Kind)
	input.ProjectID = strings.TrimSpace(input.ProjectID)
	input.ProjectName = strings.TrimSpace(input.ProjectName)
	input.AgentName = strings.TrimSpace(input.AgentName)
	if err := validateMutation(input); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}

	lockKey := input.ProjectID
	if lockKey == "" {
		lockKey = "new:" + input.ProjectName
	}
	lock := h.projectLock(lockKey)
	lock.Lock()
	defer lock.Unlock()

	preview, err := h.preparePreview(r.Context(), audit.PrincipalFromContext(r.Context()).ID, input)
	if err != nil {
		h.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, preview)
}

func (h *Handler) apply(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("previewID"))
	actorID := audit.PrincipalFromContext(r.Context()).ID
	record, err := h.takePreview(id, actorID)
	if err != nil {
		h.writeError(w, err)
		return
	}
	lock := h.projectLock(record.ProjectID)
	lock.Lock()
	defer lock.Unlock()

	if record.BaseSpecHash != "" {
		current, err := h.loadProject(r.Context(), record.ProjectID)
		if err != nil {
			h.writeError(w, err)
			return
		}
		if projectSpecHash(current) != record.BaseSpecHash {
			writeAPIError(w, http.StatusConflict, "project_changed", "项目配置已变化，请重新预览")
			return
		}
	} else if exists, err := h.projectNameExists(r.Context(), record.ProjectName); err != nil {
		h.writeError(w, err)
		return
	} else if exists {
		writeAPIError(w, http.StatusConflict, "project_changed", "同名项目已经存在，请重新加载")
		return
	}

	request := map[string]any{
		"spec":             record.Candidate,
		"expectedSpecHash": record.CandidateSpecHash,
		"dryRun":           false,
	}
	if len(record.Source) > 0 {
		request["source"] = record.Source
	}
	var response map[string]any
	if err := h.connect(r.Context(), "ApplyProject", request, &response); err != nil {
		h.writeError(w, err)
		return
	}
	if !boolValue(response["applied"]) && !boolValue(response["unchanged"]) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"code": "validation_failed", "error": "项目部署校验失败", "issues": arrayMaps(response["issues"]),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"project": response["project"], "revision": response["revision"], "changes": response["changes"],
		"issues": response["issues"], "applied": response["applied"], "unchanged": response["unchanged"],
	})
}

func (h *Handler) preparePreview(ctx context.Context, actorID string, input MutationRequest) (PreviewResponse, error) {
	var project map[string]any
	var candidate map[string]any
	var projectID, projectName, baseHash string
	var source map[string]any
	targetHadScheduler := false
	targetAgentChanged := false
	if (input.Kind == "create_project_with_agent" || input.Kind == "create_agent" || input.Kind == "update_agent") && input.Agent != nil {
		if rawEnv, ok := input.Agent["env"]; ok {
			env, err := agentEnvSpec(rawEnv)
			if err != nil {
				return PreviewResponse{}, apiError{http.StatusBadRequest, "invalid_request", err.Error()}
			}
			input.Agent["env"] = env
		}
	}

	if input.Kind == "create_project_with_agent" {
		exists, err := h.projectNameExists(ctx, input.ProjectName)
		if err != nil {
			return PreviewResponse{}, err
		}
		if exists {
			return PreviewResponse{}, apiError{http.StatusConflict, "project_exists", "同名项目已经存在"}
		}
		projectName = input.ProjectName
		variables, err := environmentSpec(input.Variables, "项目")
		if err != nil {
			return PreviewResponse{}, apiError{http.StatusBadRequest, "invalid_request", err.Error()}
		}
		candidate = map[string]any{
			"name": projectName, "variables": variables, "agents": []any{newAgentSpec(input.AgentName, input.Agent)},
		}
	} else {
		var err error
		project, err = h.loadProject(ctx, input.ProjectID)
		if err != nil {
			return PreviewResponse{}, err
		}
		projectID = projectIDValue(project)
		projectName = projectNameValue(project)
		input.ProjectName = projectName
		baseHash = projectSpecHash(project)
		if input.BaseSpecHash != "" && input.BaseSpecHash != baseHash {
			return PreviewResponse{}, apiError{http.StatusConflict, "project_changed", "项目配置已变化，请重新加载后编辑"}
		}
		spec := objectValue(project["spec"])
		if reasons := projectBlockedReasons(spec); len(reasons) > 0 {
			return PreviewResponse{}, apiError{http.StatusUnprocessableEntity, "project_read_only", strings.Join(reasons, "；")}
		}
		candidate = cloneObject(spec)
		agents := arrayValue(candidate["agents"])
		switch input.Kind {
		case "update_project_variables":
			variables, err := environmentSpec(input.Variables, "项目")
			if err != nil {
				return PreviewResponse{}, apiError{http.StatusBadRequest, "invalid_request", err.Error()}
			}
			candidate["variables"] = variables
		case "create_agent":
			if findAgentIndex(agents, input.AgentName) >= 0 {
				return PreviewResponse{}, apiError{http.StatusConflict, "agent_exists", "当前项目已存在同名智能体"}
			}
			agents = append(agents, newAgentSpec(input.AgentName, input.Agent))
		case "update_agent":
			index := findAgentIndex(agents, input.AgentName)
			if index < 0 {
				return PreviewResponse{}, apiError{http.StatusNotFound, "agent_not_found", "智能体不存在"}
			}
			current := objectValue(agents[index])
			targetHadScheduler = current["scheduler"] != nil
			agents[index] = patchAgentSpec(current, input.Agent)
		case "delete_agent":
			index := findAgentIndex(agents, input.AgentName)
			if index < 0 {
				return PreviewResponse{}, apiError{http.StatusNotFound, "agent_not_found", "智能体不存在"}
			}
			targetHadScheduler = objectValue(agents[index])["scheduler"] != nil
			agents = append(agents[:index], agents[index+1:]...)
		case "create_scheduler", "update_scheduler":
			index := findAgentIndex(agents, input.AgentName)
			if index < 0 {
				return PreviewResponse{}, apiError{http.StatusNotFound, "agent_not_found", "智能体不存在"}
			}
			current := objectValue(agents[index])
			targetHadScheduler = current["scheduler"] != nil
			if input.Kind == "create_scheduler" && targetHadScheduler {
				return PreviewResponse{}, apiError{http.StatusConflict, "scheduler_exists", "当前智能体已配置自动化"}
			}
			if input.Kind == "update_scheduler" && !targetHadScheduler {
				return PreviewResponse{}, apiError{http.StatusNotFound, "scheduler_not_found", "自动化配置不存在"}
			}
			if rawEnv, ok := input.Agent["env"]; ok {
				env, err := agentEnvSpec(rawEnv)
				if err != nil {
					return PreviewResponse{}, apiError{http.StatusBadRequest, "invalid_request", err.Error()}
				}
				targetAgentChanged = !reflect.DeepEqual(arrayValue(current["env"]), env)
				current["env"] = env
			}
			current["scheduler"] = schedulerSpec(input.Scheduler)
			agents[index] = current
		case "delete_scheduler":
			index := findAgentIndex(agents, input.AgentName)
			if index < 0 {
				return PreviewResponse{}, apiError{http.StatusNotFound, "agent_not_found", "智能体不存在"}
			}
			current := objectValue(agents[index])
			targetHadScheduler = current["scheduler"] != nil
			if !targetHadScheduler {
				return PreviewResponse{}, apiError{http.StatusNotFound, "scheduler_not_found", "自动化配置不存在"}
			}
			delete(current, "scheduler")
			agents[index] = current
		}
		candidate["agents"] = agents
		if path := projectSourcePath(project); path != "" {
			source = map[string]any{"composePath": path}
		}
	}
	normalizeDaemonProjectSpec(candidate)

	request := map[string]any{"spec": candidate, "dryRun": true}
	if len(source) > 0 {
		request["source"] = source
	}
	var response map[string]any
	if err := h.connect(ctx, "ApplyProject", request, &response); err != nil {
		return PreviewResponse{}, err
	}
	issues := arrayMaps(response["issues"])
	changes := arrayMaps(response["changes"])
	revision := objectValue(response["revision"])
	candidateHash := stringValue(revision["specHash"])
	if baseHash != "" {
		changes = mutationChanges(input, candidateHash != baseHash, targetHadScheduler, targetAgentChanged)
	}
	deployable := !hasErrorIssue(issues) && candidateHash != "" && (baseHash == "" || candidateHash != baseHash)
	if projectID == "" {
		projectID = stringValue(revision["projectId"])
		if projectID == "" {
			projectID = projectIDValue(objectValue(response["project"]))
		}
	}

	id, err := randomID()
	if err != nil {
		return PreviewResponse{}, err
	}
	expiresAt := h.now().Add(previewTTL)
	if deployable {
		h.storePreview(previewRecord{
			ID: id, ActorID: actorID, ProjectID: projectID, ProjectName: projectName, BaseSpecHash: baseHash,
			CandidateSpecHash: candidateHash, Candidate: candidate, Source: source, ExpiresAt: expiresAt,
		})
	}
	return PreviewResponse{
		PreviewID: id, ExpiresAt: expiresAt, ProjectID: projectID, ProjectName: projectName,
		BaseSpecHash: baseHash, CandidateSpecHash: candidateHash, Changes: changes, Issues: issues,
		Deployable: deployable, Mutation: MutationSummary{Kind: input.Kind, AgentName: input.AgentName},
	}, nil
}

func mutationChanges(input MutationRequest, changed, targetHadScheduler, targetAgentChanged bool) []map[string]any {
	if !changed {
		return []map[string]any{}
	}
	action := "PROJECT_CHANGE_ACTION_UPDATED"
	if input.Kind == "create_scheduler" {
		return schedulerMutationChanges("PROJECT_CHANGE_ACTION_CREATED", input.AgentName, targetAgentChanged)
	}
	if input.Kind == "update_scheduler" {
		return schedulerMutationChanges(action, input.AgentName, targetAgentChanged)
	}
	if input.Kind == "delete_scheduler" {
		return []map[string]any{{"action": "PROJECT_CHANGE_ACTION_REMOVED", "resourceType": "project_scheduler", "name": input.AgentName}}
	}
	if input.Kind == "update_project_variables" {
		return []map[string]any{{"action": action, "resourceType": "project", "name": input.ProjectName}}
	}
	if input.Kind == "create_agent" {
		action = "PROJECT_CHANGE_ACTION_CREATED"
	} else if input.Kind == "delete_agent" {
		action = "PROJECT_CHANGE_ACTION_REMOVED"
	}
	changes := []map[string]any{
		{"action": action, "resourceType": "project_agent", "name": input.AgentName},
		{"action": action, "resourceType": "agent_definition", "name": input.AgentName},
	}
	if input.Kind == "delete_agent" && targetHadScheduler {
		changes = append(changes, map[string]any{
			"action": "PROJECT_CHANGE_ACTION_REMOVED", "resourceType": "project_scheduler", "name": input.AgentName,
		})
	}
	return changes
}

func schedulerMutationChanges(action, agentName string, agentChanged bool) []map[string]any {
	changes := []map[string]any{{"action": action, "resourceType": "project_scheduler", "name": agentName}}
	if agentChanged {
		changes = append(changes,
			map[string]any{"action": "PROJECT_CHANGE_ACTION_UPDATED", "resourceType": "project_agent", "name": agentName},
			map[string]any{"action": "PROJECT_CHANGE_ACTION_UPDATED", "resourceType": "agent_definition", "name": agentName},
		)
	}
	return changes
}

func validateMutation(input MutationRequest) error {
	switch input.Kind {
	case "create_project_with_agent":
		if input.ProjectName == "" {
			return errors.New("项目名称必填")
		}
	case "update_project_variables", "create_agent", "update_agent", "delete_agent", "create_scheduler", "update_scheduler", "delete_scheduler":
		if input.ProjectID == "" {
			return errors.New("项目 ID 必填")
		}
	default:
		return errors.New("不支持的项目操作")
	}
	if input.Kind != "update_project_variables" && input.AgentName == "" {
		return errors.New("智能体调用标识必填")
	}
	if input.Kind != "update_project_variables" && input.Kind != "delete_agent" && !strings.HasSuffix(input.Kind, "_scheduler") && input.Agent == nil {
		return errors.New("智能体配置必填")
	}
	if (input.Kind == "create_scheduler" || input.Kind == "update_scheduler") && input.Scheduler == nil {
		return errors.New("自动化配置必填")
	}
	return nil
}

func schedulerSpec(input map[string]any) map[string]any {
	result := make(map[string]any, len(editableSchedulerFields))
	for key := range editableSchedulerFields {
		if value, ok := input[key]; ok {
			result[key] = cloneValue(value)
		}
	}
	return result
}

// normalizeDaemonProjectSpec upgrades UI-friendly and legacy values before
// sending a complete ProjectSpec back to the current daemon.
func normalizeDaemonProjectSpec(spec map[string]any) {
	for _, value := range arrayValue(spec["agents"]) {
		agent := objectValue(value)
		driver := objectValue(agent["driver"])
		if strings.EqualFold(stringValue(driver["name"]), "docker") && driver["docker"] == nil {
			driver["docker"] = map[string]any{}
		}
		normalizeSchedulerSpec(objectValue(agent["scheduler"]))
	}
}

func normalizeSchedulerSpec(spec map[string]any) {
	if value, ok := spec["sandboxPolicy"]; ok {
		spec["sandboxPolicy"] = schedulerSandboxPolicyName(stringValue(value))
	}
	if value, ok := spec["concurrencyPolicy"]; ok {
		spec["concurrencyPolicy"] = schedulerConcurrencyPolicyName(stringValue(value))
	}
	for _, value := range arrayValue(spec["triggers"]) {
		trigger := objectValue(value)
		if kind, ok := trigger["kind"]; ok {
			trigger["kind"] = triggerKindName(stringValue(kind))
		}
		if policy, ok := trigger["sandboxPolicy"]; ok {
			trigger["sandboxPolicy"] = schedulerSandboxPolicyName(stringValue(policy))
		}
	}
}

func schedulerSandboxPolicyName(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "sticky", "reuse", "reuse_session", "scheduler_sandbox_policy_sticky":
		return "SCHEDULER_SANDBOX_POLICY_STICKY"
	case "new", "new_session", "scheduler_sandbox_policy_new":
		return "SCHEDULER_SANDBOX_POLICY_NEW"
	default:
		return value
	}
}

func schedulerConcurrencyPolicyName(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "skip", "scheduler_concurrency_policy_skip":
		return "SCHEDULER_CONCURRENCY_POLICY_SKIP"
	case "parallel", "scheduler_concurrency_policy_parallel":
		return "SCHEDULER_CONCURRENCY_POLICY_PARALLEL"
	default:
		return value
	}
}

func triggerKindName(value string) string {
	trimmed := strings.TrimSpace(value)
	if strings.HasPrefix(strings.ToUpper(trimmed), "TRIGGER_KIND_") {
		return strings.ToUpper(trimmed)
	}
	switch strings.ToLower(trimmed) {
	case "cron", "interval", "timeout", "event":
		return "TRIGGER_KIND_" + strings.ToUpper(trimmed)
	default:
		return value
	}
}

func agentEnvSpec(value any) ([]any, error) {
	items, ok := value.([]any)
	if !ok {
		return nil, errors.New("智能体环境变量格式无效")
	}
	return environmentSpec(items, "智能体")
}

func environmentSpec(items []any, scope string) ([]any, error) {
	result := make([]any, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for _, value := range items {
		item := objectValue(value)
		name := strings.TrimSpace(stringValue(item["name"]))
		if name == "" {
			return nil, fmt.Errorf("%s环境变量名称不能为空", scope)
		}
		if _, exists := seen[name]; exists {
			return nil, fmt.Errorf("环境变量名称重复：%s", name)
		}
		seen[name] = struct{}{}
		result = append(result, map[string]any{
			"name": name, "value": stringValue(item["value"]), "secret": boolValue(item["secret"]),
		})
	}
	return result, nil
}

var editableAgentFields = map[string]struct{}{
	"provider": {}, "model": {}, "systemPrompt": {}, "image": {}, "driver": {}, "env": {}, "workspace": {},
	"capsetIds": {}, "enabled": {}, "displayName": {}, "description": {},
}

func newAgentSpec(name string, patch map[string]any) map[string]any {
	result := map[string]any{"name": name}
	return patchAgentSpec(result, patch)
}

func patchAgentSpec(current, patch map[string]any) map[string]any {
	result := cloneObject(current)
	for key := range editableAgentFields {
		if value, ok := patch[key]; ok {
			result[key] = cloneValue(value)
		} else {
			delete(result, key)
		}
	}
	result["name"] = stringValue(current["name"])
	return result
}

func projectView(project map[string]any) ProjectView {
	summary := objectValue(project["summary"])
	spec := objectValue(project["spec"])
	reasons := projectBlockedReasons(spec)
	runtimeAgents := map[string]map[string]any{}
	for _, value := range arrayValue(project["agents"]) {
		item := objectValue(value)
		runtimeAgents[stringValue(item["agentName"])] = item
	}
	agents := make([]AgentView, 0)
	for _, value := range arrayValue(spec["agents"]) {
		item := objectValue(value)
		name := stringValue(item["name"])
		runtime := runtimeAgents[name]
		driver := objectValue(item["driver"])
		workspace := objectValue(item["workspace"])
		enabled := true
		if value, ok := item["enabled"].(bool); ok {
			enabled = value
		}
		agents = append(agents, AgentView{
			ID: firstNonEmpty(stringValue(runtime["managedAgentId"]), name), AgentName: name,
			DisplayName: firstNonEmpty(stringValue(item["displayName"]), name), Description: stringValue(item["description"]),
			Enabled: enabled, Provider: stringValue(item["provider"]), Model: stringValue(item["model"]),
			SystemPrompt: stringValue(item["systemPrompt"]), Image: stringValue(item["image"]), Driver: driver,
			Env: environmentView(item["env"]), Workspace: workspace, CapsetIDs: stringArray(item["capsetIds"]),
			Availability: stringValue(runtime["availability"]), Health: stringValue(runtime["health"]),
			SchedulerEnabled: boolValue(runtime["schedulerEnabled"]), HasScheduler: item["scheduler"] != nil,
			JupyterEnabled: boolValue(objectValue(item["jupyter"])["enabled"]), MCPCount: len(arrayValue(item["mcpServers"])),
			SkillCount: len(arrayValue(item["skills"])), VolumeCount: len(arrayValue(item["volumes"])), HasBuild: item["build"] != nil,
		})
	}
	sort.Slice(agents, func(i, j int) bool {
		return strings.ToLower(agents[i].DisplayName) < strings.ToLower(agents[j].DisplayName)
	})
	return ProjectView{
		ProjectID: stringValue(summary["projectId"]), Name: stringValue(summary["name"]), SourcePath: stringValue(summary["sourcePath"]),
		CurrentRevision: fmt.Sprint(summary["currentRevision"]), SpecHash: stringValue(summary["specHash"]),
		AgentCount: intValue(summary["agentCount"]), SchedulerCount: intValue(summary["schedulerCount"]),
		RunningRunCount: intValue(summary["runningRunCount"]), UpdatedAt: stringValue(summary["updatedAt"]),
		Editable: len(reasons) == 0, BlockedReasons: reasons, Variables: environmentView(spec["variables"]), Agents: agents,
	}
}

func environmentView(value any) []any {
	items := arrayValue(value)
	result := make([]any, 0, len(items))
	for _, value := range items {
		item := objectValue(value)
		if name := stringValue(item["name"]); name != "" {
			result = append(result, map[string]any{
				"name": name, "value": stringValue(item["value"]), "secret": boolValue(item["secret"]),
			})
		}
	}
	return result
}

func projectBlockedReasons(spec map[string]any) []string {
	reasons := make([]string, 0, 2)
	if containsRedacted(spec) {
		reasons = append(reasons, "项目包含已脱敏凭据，请使用 Compose 或 CLI 修改")
	}
	if len(arrayValue(spec["octobusServers"])) > 0 {
		reasons = append(reasons, "项目包含 OctoBus 配置，当前页面仅管理全局能力网关")
	}
	return reasons
}

func containsRedacted(value any) bool {
	switch typed := value.(type) {
	case string:
		return typed == redactedSecret
	case []any:
		for _, item := range typed {
			if containsRedacted(item) {
				return true
			}
		}
	case map[string]any:
		for _, item := range typed {
			if containsRedacted(item) {
				return true
			}
		}
	}
	return false
}

func (h *Handler) allProjectSummaries(ctx context.Context) ([]map[string]any, error) {
	result := make([]map[string]any, 0)
	offset := 0
	for {
		var page listProjectsResponse
		if err := h.connect(ctx, "ListProjects", map[string]any{"limit": 200, "offset": offset}, &page); err != nil {
			return nil, err
		}
		result = append(result, page.Projects...)
		next := offset + len(page.Projects)
		if next >= page.Total || len(page.Projects) == 0 {
			return result, nil
		}
		offset = next
	}
}

func (h *Handler) projectNameExists(ctx context.Context, name string) (bool, error) {
	summaries, err := h.allProjectSummaries(ctx)
	if err != nil {
		return false, err
	}
	for _, summary := range summaries {
		if strings.EqualFold(stringValue(summary["name"]), strings.TrimSpace(name)) {
			return true, nil
		}
	}
	return false, nil
}

func (h *Handler) loadProject(ctx context.Context, projectID string) (map[string]any, error) {
	if strings.TrimSpace(projectID) == "" {
		return nil, apiError{http.StatusBadRequest, "invalid_request", "项目 ID 必填"}
	}
	var response map[string]any
	if err := h.connect(ctx, "GetProject", map[string]any{
		"project": map[string]any{"projectId": projectID}, "includeSpec": true,
	}, &response); err != nil {
		return nil, err
	}
	project := objectValue(response["project"])
	if len(project) == 0 {
		return nil, apiError{http.StatusNotFound, "project_not_found", "项目不存在"}
	}
	return project, nil
}

func (h *Handler) connect(ctx context.Context, method string, input any, output any) error {
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}
	target := *h.backend
	target.Path = "/agentcompose.v2.ProjectService/" + method
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := h.client.Do(request)
	if err != nil {
		return apiError{http.StatusBadGateway, "daemon_unavailable", err.Error()}
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return apiError{http.StatusBadGateway, "daemon_unavailable", err.Error()}
	}
	if len(data) > maxResponseBytes {
		return apiError{http.StatusBadGateway, "daemon_response_too_large", "后端服务响应过大"}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message := strings.TrimSpace(string(data))
		if message == "" {
			message = response.Status
		}
		status := http.StatusBadGateway
		if response.StatusCode == http.StatusNotFound {
			status = http.StatusNotFound
		}
		return apiError{status, "daemon_request_failed", message}
	}
	if err := json.Unmarshal(data, output); err != nil {
		return apiError{http.StatusBadGateway, "daemon_response_invalid", err.Error()}
	}
	return nil
}

func (h *Handler) projectLock(key string) *sync.Mutex {
	h.mu.Lock()
	defer h.mu.Unlock()
	lock := h.locks[key]
	if lock == nil {
		lock = &sync.Mutex{}
		h.locks[key] = lock
	}
	return lock
}

func (h *Handler) storePreview(record previewRecord) {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := h.now()
	for id, item := range h.previews {
		if item.ExpiresAt.Before(now) || item.Used {
			delete(h.previews, id)
		}
	}
	h.previews[record.ID] = record
}

func (h *Handler) takePreview(id, actorID string) (previewRecord, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	record, ok := h.previews[id]
	if !ok || record.Used || !h.now().Before(record.ExpiresAt) {
		delete(h.previews, id)
		return previewRecord{}, apiError{http.StatusGone, "preview_expired", "部署预览已失效，请重新生成"}
	}
	if record.ActorID != actorID {
		return previewRecord{}, apiError{http.StatusForbidden, "preview_forbidden", "部署预览不属于当前用户"}
	}
	record.Used = true
	h.previews[id] = record
	return record, nil
}

type apiError struct {
	status  int
	code    string
	message string
}

func (e apiError) Error() string { return e.message }

func (h *Handler) writeError(w http.ResponseWriter, err error) {
	var target apiError
	if errors.As(err, &target) {
		writeAPIError(w, target.status, target.code, target.message)
		return
	}
	writeAPIError(w, http.StatusInternalServerError, "internal_error", err.Error())
}

func writeAPIError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"code": code, "error": message})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func decodeJSON(r *http.Request, output any) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 2<<20))
	decoder.DisallowUnknownFields()
	return decoder.Decode(output)
}

func randomID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(value[:]), nil
}

func findAgentIndex(agents []any, name string) int {
	for index, value := range agents {
		if stringValue(objectValue(value)["name"]) == name {
			return index
		}
	}
	return -1
}

func projectIDValue(project map[string]any) string {
	return stringValue(objectValue(project["summary"])["projectId"])
}
func projectNameValue(project map[string]any) string {
	return stringValue(objectValue(project["summary"])["name"])
}
func projectSpecHash(project map[string]any) string {
	return stringValue(objectValue(project["summary"])["specHash"])
}
func projectSourcePath(project map[string]any) string {
	return stringValue(objectValue(project["summary"])["sourcePath"])
}

func hasErrorIssue(issues []map[string]any) bool {
	for _, issue := range issues {
		if strings.Contains(strings.ToUpper(fmt.Sprint(issue["severity"])), "ERROR") {
			return true
		}
	}
	return false
}

func cloneObject(value map[string]any) map[string]any { return cloneValue(value).(map[string]any) }
func cloneValue(value any) any {
	data, _ := json.Marshal(value)
	var result any
	_ = json.Unmarshal(data, &result)
	return result
}

func objectValue(value any) map[string]any {
	result, _ := value.(map[string]any)
	if result == nil {
		return map[string]any{}
	}
	return result
}

func arrayValue(value any) []any {
	result, _ := value.([]any)
	return result
}

func arrayMaps(value any) []map[string]any {
	items := arrayValue(value)
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		result = append(result, objectValue(item))
	}
	return result
}

func stringValue(value any) string {
	result, _ := value.(string)
	return strings.TrimSpace(result)
}

func stringArray(value any) []string {
	items := arrayValue(value)
	result := make([]string, 0, len(items))
	for _, item := range items {
		if value := stringValue(item); value != "" {
			result = append(result, value)
		}
	}
	return result
}

func boolValue(value any) bool { result, _ := value.(bool); return result }
func intValue(value any) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case json.Number:
		result, _ := typed.Int64()
		return int(result)
	}
	return 0
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
