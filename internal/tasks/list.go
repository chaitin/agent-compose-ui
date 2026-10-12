package tasks

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"agent-compose-ui/internal/config"
)

const (
	// The backend lists scheduler runs per project and agent only, so the list
	// is assembled from the most recent runs of every agent. Every run comes
	// with its full payload, which makes this read the expensive part.
	runsPerAgent = 50
	// The assembled list is reused for this long.
	listCacheTTL = 10 * time.Second
	// An agent whose recent runs carried no task is not read again until it
	// runs again, or for this long at most.
	tasklessAgentTTL = 10 * time.Minute
	// A rebuild serves every waiting request, so it does not end with the
	// request that happened to start it.
	listRebuildTimeout = 60 * time.Second
	maxSchedulers      = 500
	maxListedTasks     = 300
	// A failed run can carry a whole stack trace; a list row shows one line.
	maxErrorRunes   = 300
	statusRunning   = "running"
	statusFailed    = "failed"
	statusCanceled  = "canceled"
	statusSucceeded = "succeeded"
)

// Execution is one scheduler run working on a task.
type Execution struct {
	RunID         string   `json:"run_id"`
	SchedulerID   string   `json:"scheduler_id"`
	SchedulerName string   `json:"scheduler_name"`
	ProjectID     string   `json:"project_id"`
	AgentName     string   `json:"agent_name"`
	Status        string   `json:"status"`
	StartedAt     string   `json:"started_at"`
	CompletedAt   string   `json:"completed_at"`
	DurationMs    int64    `json:"duration_ms"`
	Error         string   `json:"error"`
	EventID       string   `json:"event_id"`
	SandboxIDs    []string `json:"sandbox_ids"`
}

// ListedTask groups the executions that share a correlation ID. Executions
// without one stand alone.
type ListedTask struct {
	Key           string      `json:"key"`
	CorrelationID string      `json:"correlation_id"`
	Title         string      `json:"title"`
	URL           string      `json:"url"`
	Status        string      `json:"status"`
	StartedAt     string      `json:"started_at"`
	LatestAt      string      `json:"latest_at"`
	Executions    []Execution `json:"executions"`
}

type listResponse struct {
	// TitlesEnabled is false when no task fields are configured; every
	// execution is then listed, without a title.
	TitlesEnabled bool         `json:"titles_enabled"`
	Tasks         []ListedTask `json:"tasks"`
	// Truncated reports that older executions exist beyond what was read.
	Truncated bool `json:"truncated"`
}

type schedulerSummary struct {
	SchedulerID string `json:"schedulerId"`
	ProjectID   string `json:"projectId"`
	AgentName   string `json:"agentName"`
	DisplayName string `json:"displayName"`
	RunCount    int64  `json:"runCount"`
}

type schedulerRun struct {
	RunID       string      `json:"runId"`
	SchedulerID string      `json:"schedulerId"`
	ProjectID   string      `json:"projectId"`
	AgentName   string      `json:"agentName"`
	Status      string      `json:"status"`
	StartedAt   string      `json:"startedAt"`
	CompletedAt string      `json:"completedAt"`
	DurationMs  json.Number `json:"durationMs"`
	Error       string      `json:"error"`
	PayloadJSON string      `json:"payloadJson"`
	SandboxIDs  []string    `json:"sandboxIds"`
}

type agentRuns struct {
	projectID      string
	agentName      string
	schedulerNames map[string]string
	runs           []schedulerRun
	total          int64
	// runCount is the number of runs the agent's schedulers reported.
	runCount int64
}

// tasklessAgent records when an agent's recent runs were found to carry no
// task, and how many runs it had at the time.
type tasklessAgent struct {
	checkedAt time.Time
	runCount  int64
}

// listCache holds the last assembled list and what was learned while
// assembling it. Its mutex also makes concurrent requests share one read.
type listCache struct {
	mu       sync.Mutex
	response listResponse
	builtAt  time.Time
	taskless map[string]tasklessAgent
}

func (h *Handler) listTasks(w http.ResponseWriter, r *http.Request) {
	h.list.mu.Lock()
	defer h.list.mu.Unlock()
	if !h.list.builtAt.IsZero() && h.now().Sub(h.list.builtAt) < listCacheTTL {
		writeJSON(w, http.StatusOK, h.list.response)
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), listRebuildTimeout)
	defer cancel()
	agents, err := h.recentRuns(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	tasks, carriesTask := groupTasks(agents, h.fields)
	response := listResponse{TitlesEnabled: len(h.fields) > 0, Tasks: tasks}
	taskless := h.rememberTasklessAgents(agents, carriesTask)
	for _, agent := range agents {
		// Older runs of an agent that carries no task would not be listed anyway.
		if agent.total > int64(len(agent.runs)) && !taskless[agentKey(agent.projectID, agent.agentName)] {
			response.Truncated = true
		}
	}
	if len(response.Tasks) > maxListedTasks {
		response.Tasks = response.Tasks[:maxListedTasks]
		response.Truncated = true
	}
	h.list.response, h.list.builtAt = response, h.now()
	writeJSON(w, http.StatusOK, response)
}

func agentKey(projectID, agentName string) string { return projectID + "\x00" + agentName }

// rememberTasklessAgents notes the agents whose runs carried no task, so the
// next reads can leave them out, and returns them. Without task fields every
// run is listed and nothing is skipped.
func (h *Handler) rememberTasklessAgents(agents []agentRuns, carriesTask map[string]bool) map[string]bool {
	found := map[string]bool{}
	if len(h.fields) == 0 {
		return found
	}
	if h.list.taskless == nil {
		h.list.taskless = map[string]tasklessAgent{}
	}
	for _, agent := range agents {
		key := agentKey(agent.projectID, agent.agentName)
		if carriesTask[key] {
			delete(h.list.taskless, key)
		} else {
			h.list.taskless[key] = tasklessAgent{checkedAt: h.now(), runCount: agent.runCount}
			found[key] = true
		}
	}
	return found
}

// recentRuns reads the latest runs of every agent that has a scheduler.
func (h *Handler) recentRuns(ctx context.Context) ([]agentRuns, error) {
	var schedulers struct {
		Schedulers []schedulerSummary `json:"schedulers"`
	}
	if err := h.connect(ctx, "ListSchedulers", map[string]any{"limit": maxSchedulers}, &schedulers); err != nil {
		return nil, err
	}
	// Runs are listed per project and agent, so several schedulers of one
	// agent share a listing.
	var candidates []agentRuns
	position := map[string]int{}
	names := map[string]string{}
	for _, scheduler := range schedulers.Schedulers {
		names[scheduler.SchedulerID] = scheduler.DisplayName
		if scheduler.RunCount == 0 || scheduler.ProjectID == "" {
			continue
		}
		key := agentKey(scheduler.ProjectID, scheduler.AgentName)
		index, known := position[key]
		if !known {
			index = len(candidates)
			position[key] = index
			candidates = append(candidates, agentRuns{projectID: scheduler.ProjectID, agentName: scheduler.AgentName, schedulerNames: names})
		}
		candidates[index].runCount += scheduler.RunCount
	}
	var agents []agentRuns
	for _, agent := range candidates {
		// A taskless agent that has run since it was checked may have picked
		// up a task, so it is read again.
		known, taskless := h.list.taskless[agentKey(agent.projectID, agent.agentName)]
		if taskless && known.runCount == agent.runCount && h.now().Sub(known.checkedAt) < tasklessAgentTTL {
			continue
		}
		agents = append(agents, agent)
	}
	err := forEach(len(agents), func(index int) error {
		var page struct {
			Runs  []schedulerRun `json:"runs"`
			Total int64          `json:"total"`
		}
		if err := h.connect(ctx, "ListSchedulerRuns", map[string]any{
			"project":   map[string]any{"projectId": agents[index].projectID},
			"agentName": agents[index].agentName,
			"limit":     runsPerAgent,
		}, &page); err != nil {
			return err
		}
		agents[index].runs, agents[index].total = page.Runs, page.Total
		return nil
	})
	return agents, err
}

// groupTasks turns runs into tasks, newest activity first, and reports which
// agents had a run carrying a task. With task fields configured, only runs
// whose payload carries a task are kept.
func groupTasks(agents []agentRuns, fields []config.SandboxTaskField) ([]ListedTask, map[string]bool) {
	index := map[string]int{}
	tasks := []ListedTask{}
	carriesTask := map[string]bool{}
	for _, agent := range agents {
		for _, run := range agent.runs {
			payload := parsePayload(run.PayloadJSON)
			title, link, hasTask := taskFromPayload(payload, fields)
			if hasTask {
				carriesTask[agentKey(agent.projectID, agent.agentName)] = true
			}
			if len(fields) > 0 && !hasTask {
				continue
			}
			correlationID := textAt(payload, "payload.correlationId")
			key := "run:" + run.RunID
			if correlationID != "" {
				key = "correlation:" + correlationID
			}
			position, known := index[key]
			if !known {
				position = len(tasks)
				index[key] = position
				tasks = append(tasks, ListedTask{Key: key, CorrelationID: correlationID, Executions: []Execution{}})
			}
			task := &tasks[position]
			if task.Title == "" {
				task.Title, task.URL = title, link
			}
			duration, _ := strconv.ParseInt(run.DurationMs.String(), 10, 64)
			task.Executions = append(task.Executions, Execution{
				RunID:         run.RunID,
				SchedulerID:   run.SchedulerID,
				SchedulerName: agent.schedulerNames[run.SchedulerID],
				ProjectID:     firstNonEmpty(run.ProjectID, agent.projectID),
				AgentName:     firstNonEmpty(run.AgentName, agent.agentName),
				Status:        runStatus(run.Status),
				StartedAt:     run.StartedAt,
				CompletedAt:   run.CompletedAt,
				DurationMs:    duration,
				Error:         summarizeError(run.Error),
				EventID:       textAt(payload, "payload.eventId"),
				SandboxIDs:    append([]string{}, run.SandboxIDs...),
			})
		}
	}
	for position := range tasks {
		task := &tasks[position]
		// RFC 3339 UTC timestamps from the backend sort correctly as strings.
		sort.SliceStable(task.Executions, func(i, j int) bool {
			return task.Executions[i].StartedAt < task.Executions[j].StartedAt
		})
		task.StartedAt = task.Executions[0].StartedAt
		for _, execution := range task.Executions {
			task.LatestAt = max(task.LatestAt, execution.StartedAt, execution.CompletedAt)
		}
		task.Status = taskStatus(task.Executions)
	}
	sort.SliceStable(tasks, func(i, j int) bool { return tasks[i].LatestAt > tasks[j].LatestAt })
	return tasks, carriesTask
}

// taskStatus judges a task by the latest execution of each scheduler, so an
// earlier failure that a retry fixed no longer counts.
func taskStatus(executions []Execution) string {
	latest := map[string]string{}
	for _, execution := range executions {
		latest[execution.SchedulerID] = execution.Status
	}
	has := func(status string) bool {
		for _, value := range latest {
			if value == status {
				return true
			}
		}
		return false
	}
	for _, status := range []string{statusRunning, statusFailed, statusCanceled} {
		if has(status) {
			return status
		}
	}
	if has(statusSucceeded) {
		return statusSucceeded
	}
	return executions[len(executions)-1].Status
}

// summarizeError keeps the start of an error; the full text stays on the run.
func summarizeError(value string) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) <= maxErrorRunes {
		return string(runes)
	}
	return string(runes[:maxErrorRunes]) + "…"
}

// runStatus maps SCHEDULER_RUN_STATUS_FAILED to "failed".
func runStatus(value string) string {
	return strings.ToLower(strings.TrimPrefix(value, "SCHEDULER_RUN_STATUS_"))
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
