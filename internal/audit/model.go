package audit

import "time"

type Principal struct {
	ID          string `json:"id"`
	Source      string `json:"source"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	AuthMethod  string `json:"authMethod"`
}

type Event struct {
	ID           string     `json:"id"`
	OccurredAt   time.Time  `json:"occurredAt"`
	FinishedAt   *time.Time `json:"finishedAt,omitempty"`
	Actor        Principal  `json:"actor"`
	Category     string     `json:"category"`
	Action       string     `json:"action"`
	ResourceType string     `json:"resourceType,omitempty"`
	ResourceID   string     `json:"resourceId,omitempty"`
	Method       string     `json:"method"`
	Path         string     `json:"path"`
	Outcome      string     `json:"outcome"`
	Status       int        `json:"status"`
	DurationMs   int64      `json:"durationMs"`
	RequestID    string     `json:"requestId,omitempty"`
	RemoteIP     string     `json:"remoteIp,omitempty"`
	UserAgent    string     `json:"userAgent,omitempty"`
}

type Input struct {
	Actor        Principal
	Category     string
	Action       string
	ResourceType string
	ResourceID   string
	Method       string
	Path         string
	RequestID    string
	RemoteIP     string
	UserAgent    string
	Outcome      string
	Status       int
	Duration     time.Duration
}

type Filter struct {
	From         time.Time
	To           time.Time
	Actor        string
	Action       string
	Outcome      string
	ResourceType string
	ResourceID   string
	Cursor       string
	Limit        int
}

type Page struct {
	Items      []Event `json:"items"`
	NextCursor string  `json:"nextCursor,omitempty"`
	HasMore    bool    `json:"hasMore"`
}
