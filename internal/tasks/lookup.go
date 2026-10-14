package tasks

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"sync"
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

// sandboxExecution is a Sandbox's latest scheduler run without its payload
// and result, which the list does not show and which can be large.
type sandboxExecution struct {
	SandboxID   string `json:"sandbox_id"`
	RunID       string `json:"run_id"`
	SchedulerID string `json:"scheduler_id"`
	Status      string `json:"status"`
	TriggerKind string `json:"trigger_kind"`
	StartedAt   string `json:"started_at"`
	CompletedAt string `json:"completed_at"`
	DurationMs  int64  `json:"duration_ms"`
	Error       string `json:"error"`
}

type latestRunsResponse struct {
	Results []struct {
		SandboxID string        `json:"sandboxId"`
		Run       *schedulerRun `json:"run"`
	} `json:"results"`
}

// sandboxTasks reports each Sandbox's latest scheduler run and the task
// behind it. Enabled is false when no task fields are configured for this
// deployment; executions are reported either way.
func (h *Handler) sandboxTasks(w http.ResponseWriter, r *http.Request) {
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
	tasks, executions := []sandboxTask{}, []sandboxExecution{}
	for _, projectID := range projects {
		projectTasks, projectExecutions, err := h.projectSandboxActivity(r.Context(), projectID, sandboxesByProject[projectID])
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		tasks, executions = append(tasks, projectTasks...), append(executions, projectExecutions...)
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": len(h.fields) > 0, "tasks": tasks, "executions": executions})
}

func (h *Handler) projectSandboxActivity(ctx context.Context, projectID string, sandboxIDs []string) ([]sandboxTask, []sandboxExecution, error) {
	var runs latestRunsResponse
	if err := h.connect(ctx, "BatchGetLatestSchedulerRuns", map[string]any{
		"project":    map[string]any{"projectId": projectID},
		"sandboxIds": sandboxIDs,
	}, &runs); err != nil {
		return nil, nil, err
	}
	var tasks []sandboxTask
	var executions []sandboxExecution
	for _, item := range runs.Results {
		if item.Run == nil {
			continue
		}
		executions = append(executions, sandboxExecution{
			SandboxID:   item.SandboxID,
			RunID:       item.Run.RunID,
			SchedulerID: item.Run.SchedulerID,
			Status:      runStatus(item.Run.Status),
			TriggerKind: strings.ToLower(strings.TrimPrefix(item.Run.TriggerKind, "TRIGGER_KIND_")),
			StartedAt:   item.Run.StartedAt,
			CompletedAt: item.Run.CompletedAt,
			DurationMs:  durationMs(*item.Run),
			Error:       summarizeError(item.Run.Error),
		})
		if title, link, ok := taskFromPayload(parsePayload(item.Run.PayloadJSON), h.fields); ok {
			tasks = append(tasks, sandboxTask{SandboxID: item.SandboxID, Task: Task{Title: title, URL: link}})
		}
	}
	return tasks, executions, nil
}

// eventTaskCache remembers the task of events that were read. An event's
// payload never changes, so entries do not expire; a nil task records an
// event without one.
type eventTaskCache struct {
	mu    sync.Mutex
	tasks map[string]*Task
}

func (c *eventTaskCache) get(eventID string) (*Task, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	task, known := c.tasks[eventID]
	return task, known
}

func (c *eventTaskCache) put(eventID string, task *Task) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.tasks == nil || len(c.tasks) >= maxCachedEventTasks {
		c.tasks = map[string]*Task{}
	}
	c.tasks[eventID] = task
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
		if task, known := h.events.get(eventID); known {
			if task != nil {
				resolved[index] = &eventTask{EventID: eventID, Task: *task}
			}
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
		var task *Task
		if title, link, ok := taskFromPayload(envelope, h.fields); ok {
			task = &Task{Title: title, URL: link}
			resolved[index] = &eventTask{EventID: eventID, Task: *task}
		}
		h.events.put(eventID, task)
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
