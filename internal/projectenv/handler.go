package projectenv

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

const (
	validateProjectProcedure = "/agentcompose.v2.ProjectService/ValidateProject"
	applyProjectProcedure    = "/agentcompose.v2.ProjectService/ApplyProject"
	getProjectProcedure      = "/agentcompose.v2.ProjectService/GetProject"
	getGlobalEnvProcedure    = "/agentcompose.v2.SettingsService/GetGlobalEnv"
	updateGlobalEnvProcedure = "/agentcompose.v2.SettingsService/UpdateGlobalEnv"
	projectStatusPath        = "/api/project-env/status"
	maxProjectBodyBytes      = 8 << 20
)

type Handler struct {
	target   *url.URL
	globals  *GlobalStore
	shadows  *ShadowStore
	fallback http.Handler
	client   *http.Client
}

func NewHandler(target *url.URL, globals *GlobalStore, shadows *ShadowStore, fallback http.Handler) http.Handler {
	return &Handler{target: target, globals: globals, shadows: shadows, fallback: fallback, client: http.DefaultClient}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && r.URL.Path == projectStatusPath {
		h.serveStatus(w, r)
		return
	}
	if r.Method != http.MethodPost || !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		h.fallback.ServeHTTP(w, r)
		return
	}
	switch r.URL.Path {
	case validateProjectProcedure, applyProjectProcedure:
		h.serveWrite(w, r)
	case getProjectProcedure:
		h.serveGet(w, r)
	case getGlobalEnvProcedure:
		h.serveRedacted(w, r)
	case updateGlobalEnvProcedure:
		h.serveGlobalUpdate(w, r)
	default:
		h.fallback.ServeHTTP(w, r)
	}
}

func (h *Handler) serveRedacted(w http.ResponseWriter, r *http.Request) {
	request, err := readJSONObject(r.Body)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid settings request")
		return
	}
	response, status, headers, err := h.forward(r, request)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "daemon request failed")
		return
	}
	redactSecrets(response)
	writeForwardedJSON(w, status, headers, response)
}

func (h *Handler) serveStatus(w http.ResponseWriter, r *http.Request) {
	projectID := strings.TrimSpace(r.URL.Query().Get("project_id"))
	if projectID == "" {
		writeJSONError(w, http.StatusBadRequest, "project_id is required")
		return
	}
	shadow, found, err := h.shadows.Get(r.Context(), projectID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "read project environment status")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"pendingSync": found && shadow.PendingSync})
}

func (h *Handler) serveGlobalUpdate(w http.ResponseWriter, r *http.Request) {
	request, err := readJSONObject(r.Body)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid global environment request")
		return
	}
	before, err := h.globals.Snapshot(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusServiceUnavailable, "global environment is unavailable")
		return
	}
	response, status, headers, err := h.forward(r, request)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "daemon request failed")
		return
	}
	if status >= 200 && status < 300 {
		after, snapshotErr := h.globals.Snapshot(r.Context())
		if snapshotErr != nil {
			writeJSONError(w, http.StatusServiceUnavailable, "global environment is unavailable")
			return
		}
		changed := changedGlobalNames(before, after)
		affected, markErr := h.shadows.MarkReferencesPending(r.Context(), changed)
		if markErr != nil {
			writeJSONError(w, http.StatusInternalServerError, "mark dependent projects pending")
			return
		}
		w.Header().Set("X-Agent-Compose-Pending-Projects", fmt.Sprintf("%d", len(affected)))
	}
	redactSecrets(response)
	writeForwardedJSON(w, status, headers, response)
}

func (h *Handler) serveWrite(w http.ResponseWriter, r *http.Request) {
	request, err := readJSONObject(r.Body)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid project request")
		return
	}
	originalSpec, ok := request["spec"].(map[string]any)
	if !ok {
		writeJSONError(w, http.StatusBadRequest, "project spec is required")
		return
	}
	globals, err := h.globals.Snapshot(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusServiceUnavailable, "global environment is unavailable")
		return
	}
	resolved, err := ResolveSpec(originalSpec, globals)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	request["spec"] = resolved.Spec
	response, status, headers, err := h.forward(r, request)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "daemon request failed")
		return
	}
	if status >= 200 && status < 300 && r.URL.Path == applyProjectProcedure {
		if applied, _ := response["applied"].(bool); applied && !boolValue(request["dryRun"]) {
			projectID := nestedString(response, "project", "summary", "projectId")
			if projectID == "" {
				writeJSONError(w, http.StatusBadGateway, "daemon response is missing project identity")
				return
			}
			specJSON, marshalErr := json.Marshal(originalSpec)
			if marshalErr != nil {
				writeJSONError(w, http.StatusInternalServerError, "store project reference configuration")
				return
			}
			shadow := ShadowProject{
				ProjectID:      projectID,
				SourcePath:     nestedString(request, "source", "composePath"),
				SpecJSON:       string(specJSON),
				DaemonSpecHash: nestedString(response, "revision", "specHash"),
				References:     resolved.References,
			}
			if err := h.shadows.SaveApplied(r.Context(), shadow); err != nil {
				writeJSONError(w, http.StatusInternalServerError, "store project reference configuration")
				return
			}
		}
	}
	redactGlobalSecrets(response, globals)
	if status >= 200 && status < 300 {
		rewriteSpecs(response, originalSpec)
	}
	writeForwardedJSON(w, status, headers, response)
}

func (h *Handler) serveGet(w http.ResponseWriter, r *http.Request) {
	request, err := readJSONObject(r.Body)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid project request")
		return
	}
	response, status, headers, err := h.forward(r, request)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "daemon request failed")
		return
	}
	if status >= 200 && status < 300 {
		projectID := nestedString(response, "project", "summary", "projectId")
		if shadow, found, getErr := h.shadows.Get(r.Context(), projectID); getErr != nil {
			writeJSONError(w, http.StatusInternalServerError, "read project reference configuration")
			return
		} else if found {
			var spec map[string]any
			if json.Unmarshal([]byte(shadow.SpecJSON), &spec) == nil {
				rewriteSpecs(response, spec)
			}
		} else {
			redactSecrets(response)
		}
	}
	writeForwardedJSON(w, status, headers, response)
}

func (h *Handler) forward(source *http.Request, body map[string]any) (map[string]any, int, http.Header, error) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, 0, nil, err
	}
	target := *h.target
	target.Path = source.URL.Path
	target.RawQuery = source.URL.RawQuery
	request, err := http.NewRequestWithContext(source.Context(), source.Method, target.String(), bytes.NewReader(encoded))
	if err != nil {
		return nil, 0, nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	if value := source.Header.Get("Connect-Protocol-Version"); value != "" {
		request.Header.Set("Connect-Protocol-Version", value)
	}
	response, err := h.client.Do(request)
	if err != nil {
		return nil, 0, nil, err
	}
	defer func() { _ = response.Body.Close() }()
	decoded, err := readJSONObject(response.Body)
	if err != nil {
		return nil, 0, nil, fmt.Errorf("decode daemon response: %w", err)
	}
	return decoded, response.StatusCode, response.Header.Clone(), nil
}

func readJSONObject(reader io.Reader) (map[string]any, error) {
	limited := io.LimitReader(reader, maxProjectBodyBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil || len(data) > maxProjectBodyBytes {
		return nil, fmt.Errorf("request body is too large")
	}
	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func rewriteSpecs(response map[string]any, spec map[string]any) {
	for _, key := range []string{"project", "revision"} {
		if item, ok := response[key].(map[string]any); ok {
			item["spec"] = cloneJSON(spec)
		}
	}
}

func redactSecrets(value any) {
	switch typed := value.(type) {
	case map[string]any:
		if secret, _ := typed["secret"].(bool); secret {
			if _, exists := typed["value"]; exists {
				typed["value"] = "********"
			}
		}
		for _, item := range typed {
			redactSecrets(item)
		}
	case []any:
		for _, item := range typed {
			redactSecrets(item)
		}
	}
}

func redactGlobalSecrets(value any, globals map[string]GlobalValue) {
	secrets := make([]string, 0)
	for _, global := range globals {
		if global.Secret && global.Value != "" {
			secrets = append(secrets, global.Value)
		}
	}
	sort.Slice(secrets, func(i, j int) bool { return len(secrets[i]) > len(secrets[j]) })
	redactStrings(value, secrets)
}

func redactStrings(value any, secrets []string) {
	switch typed := value.(type) {
	case map[string]any:
		for key, item := range typed {
			if text, ok := item.(string); ok {
				for _, secret := range secrets {
					text = strings.ReplaceAll(text, secret, "********")
				}
				typed[key] = text
				continue
			}
			redactStrings(item, secrets)
		}
	case []any:
		for _, item := range typed {
			redactStrings(item, secrets)
		}
	}
}

func nestedString(value map[string]any, keys ...string) string {
	var current any = value
	for _, key := range keys {
		object, ok := current.(map[string]any)
		if !ok {
			return ""
		}
		current = object[key]
	}
	text, _ := current.(string)
	return strings.TrimSpace(text)
}

func boolValue(value any) bool {
	result, _ := value.(bool)
	return result
}

func changedGlobalNames(before, after map[string]GlobalValue) []string {
	changed := make(map[string]struct{})
	for name, oldValue := range before {
		if newValue, ok := after[name]; !ok || newValue != oldValue {
			changed[name] = struct{}{}
		}
	}
	for name, newValue := range after {
		if oldValue, ok := before[name]; !ok || oldValue != newValue {
			changed[name] = struct{}{}
		}
	}
	names := make([]string, 0, len(changed))
	for name := range changed {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func writeForwardedJSON(w http.ResponseWriter, status int, headers http.Header, body map[string]any) {
	if value := headers.Get("Connect-Protocol-Version"); value != "" {
		w.Header().Set("Connect-Protocol-Version", value)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"message": message})
}
