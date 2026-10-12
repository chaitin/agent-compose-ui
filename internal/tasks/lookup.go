package tasks

import (
	"context"
	"net/http"
	"net/url"
	"strings"
)

// Task is the part of a trigger payload the browser may see.
type Task struct {
	Title string `json:"title"`
	URL   string `json:"url"`
}

type sandboxTask struct {
	SandboxID string `json:"sandbox_id"`
	Task
}

type eventTask struct {
	EventID string `json:"event_id"`
	Task
}

type latestRunsResponse struct {
	Results []struct {
		SandboxID string `json:"sandboxId"`
		Run       struct {
			PayloadJSON string `json:"payloadJson"`
		} `json:"run"`
	} `json:"results"`
}

// sandboxTasks resolves the task behind each Sandbox's latest scheduler run.
// Enabled is false when no task fields are configured for this deployment.
func (h *Handler) sandboxTasks(w http.ResponseWriter, r *http.Request) {
	if len(h.fields) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false, "tasks": []sandboxTask{}})
		return
	}
	var input struct {
		Sandboxes []struct {
			SandboxID string `json:"sandbox_id"`
			ProjectID string `json:"project_id"`
		} `json:"sandboxes"`
	}
	if err := decodeBody(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(input.Sandboxes) > maxLookupItems {
		writeError(w, http.StatusBadRequest, "too many sandboxes")
		return
	}
	var projects []string
	sandboxesByProject := map[string][]string{}
	for _, item := range input.Sandboxes {
		projectID, sandboxID := strings.TrimSpace(item.ProjectID), strings.TrimSpace(item.SandboxID)
		if projectID == "" || sandboxID == "" {
			continue
		}
		if _, seen := sandboxesByProject[projectID]; !seen {
			projects = append(projects, projectID)
		}
		sandboxesByProject[projectID] = append(sandboxesByProject[projectID], sandboxID)
	}
	found := []sandboxTask{}
	for _, projectID := range projects {
		tasks, err := h.projectSandboxTasks(r.Context(), projectID, sandboxesByProject[projectID])
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		found = append(found, tasks...)
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "tasks": found})
}

func (h *Handler) projectSandboxTasks(ctx context.Context, projectID string, sandboxIDs []string) ([]sandboxTask, error) {
	var runs latestRunsResponse
	if err := h.connect(ctx, "BatchGetLatestSchedulerRuns", map[string]any{
		"project":    map[string]any{"projectId": projectID},
		"sandboxIds": sandboxIDs,
	}, &runs); err != nil {
		return nil, err
	}
	var tasks []sandboxTask
	for _, item := range runs.Results {
		if title, link, ok := taskFromPayload(parsePayload(item.Run.PayloadJSON), h.fields); ok {
			tasks = append(tasks, sandboxTask{SandboxID: item.SandboxID, Task: Task{Title: title, URL: link}})
		}
	}
	return tasks, nil
}

// eventTasks resolves the task carried by each event. Events that cannot be
// read or carry no task are left out.
func (h *Handler) eventTasks(w http.ResponseWriter, r *http.Request) {
	if len(h.fields) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false, "tasks": []eventTask{}})
		return
	}
	var input struct {
		EventIDs []string `json:"event_ids"`
	}
	if err := decodeBody(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(input.EventIDs) > maxLookupItems {
		writeError(w, http.StatusBadRequest, "too many events")
		return
	}
	resolved := make([]*eventTask, len(input.EventIDs))
	_ = forEach(len(input.EventIDs), func(index int) error {
		eventID := strings.TrimSpace(input.EventIDs[index])
		if eventID == "" {
			return nil
		}
		var document struct {
			Event struct {
				Payload any `json:"payload"`
			} `json:"event"`
		}
		if err := h.get(r.Context(), "/api/events/"+url.PathEscape(eventID), &document); err != nil {
			return nil
		}
		// Scheduler runs see an event as {topic, createdAt, payload}; wrap the
		// event the same way so one set of configured paths serves both.
		envelope := map[string]any{"payload": document.Event.Payload}
		if title, link, ok := taskFromPayload(envelope, h.fields); ok {
			resolved[index] = &eventTask{EventID: eventID, Task: Task{Title: title, URL: link}}
		}
		return nil
	})
	found := []eventTask{}
	for _, item := range resolved {
		if item != nil {
			found = append(found, *item)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "tasks": found})
}
