package audit

import (
	"context"
	"log/slog"
	"net/http"
	"time"
)

type Middleware struct {
	store  *Store
	logger *slog.Logger
}

func NewMiddleware(store *Store, logger *slog.Logger) *Middleware {
	return &Middleware{store: store, logger: logger}
}

func (m *Middleware) Wrap(next http.Handler) http.Handler {
	if m == nil || m.store == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		op, ok := inspectOperation(r)
		if !ok {
			next.ServeHTTP(w, r)
			return
		}
		started := time.Now()
		input := Input{Actor: PrincipalFromContext(r.Context()), Category: op.Category, Action: op.Action,
			ResourceType: op.ResourceType, ResourceID: op.ResourceID, Method: r.Method, Path: r.URL.Path,
			RequestID: r.Header.Get("X-Request-ID"), RemoteIP: remoteIP(r), UserAgent: r.UserAgent()}
		id, err := m.store.Start(r.Context(), input)
		if err != nil {
			m.logError(r.Context(), "start", err)
		}
		tracked := &responseStatus{ResponseWriter: w, status: http.StatusOK}
		defer func() {
			panicValue := recover()
			if panicValue != nil {
				tracked.status = http.StatusInternalServerError
			}
			outcome := outcomeForStatus(tracked.status)
			if err := m.store.Finish(context.WithoutCancel(r.Context()), id, outcome, tracked.status, time.Since(started)); err != nil {
				m.logError(r.Context(), "finish", err)
			}
			if panicValue != nil {
				panic(panicValue)
			}
		}()
		next.ServeHTTP(tracked, r)
	})
}

func outcomeForStatus(status int) string {
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return "denied"
	}
	if status >= http.StatusBadRequest {
		return "failure"
	}
	return "success"
}

func (m *Middleware) Record(ctx context.Context, input Input) {
	if m == nil || m.store == nil {
		return
	}
	if err := m.store.Record(context.WithoutCancel(ctx), input); err != nil {
		m.logError(ctx, "record", err)
	}
}

func (m *Middleware) logError(ctx context.Context, stage string, err error) {
	if m.logger != nil {
		m.logger.ErrorContext(ctx, "audit write failed", "stage", stage, "error", err)
	}
}

type responseStatus struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (w *responseStatus) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *responseStatus) WriteHeader(status int) {
	if w.wrote {
		return
	}
	w.wrote = true
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}
func (w *responseStatus) Write(value []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(value)
}
func (w *responseStatus) Flush() {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}

func remoteIP(r *http.Request) string {
	if value := r.Header.Get("X-Forwarded-For"); value != "" {
		for index, char := range value {
			if char == ',' {
				return value[:index]
			}
		}
		return value
	}
	return r.RemoteAddr
}
