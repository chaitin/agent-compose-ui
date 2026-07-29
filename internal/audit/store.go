package audit

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	db        *sql.DB
	now       func() time.Time
	retention time.Duration
}

func OpenStore(path string, retentionDays int) (*Store, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("audit database path is required")
	}
	db, err := sql.Open("sqlite", filepath.Clean(path))
	if err != nil {
		return nil, fmt.Errorf("open audit database: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	store := &Store{db: db, now: time.Now, retention: time.Duration(retentionDays) * 24 * time.Hour}
	if err := store.init(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) init(ctx context.Context) error {
	statements := []string{
		`PRAGMA journal_mode=WAL`,
		`PRAGMA busy_timeout=5000`,
		`CREATE TABLE IF NOT EXISTS oauth_principal (
			provider TEXT NOT NULL,
			subject TEXT NOT NULL,
			principal_id TEXT NOT NULL,
			username TEXT NOT NULL,
			display_name TEXT NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY(provider, subject)
		)`,
		`CREATE TABLE IF NOT EXISTS audit_event (
			id TEXT PRIMARY KEY,
			occurred_at INTEGER NOT NULL,
			finished_at INTEGER,
			actor_id TEXT NOT NULL,
			actor_source TEXT NOT NULL,
			actor_username TEXT NOT NULL,
			actor_display_name TEXT NOT NULL,
			auth_method TEXT NOT NULL,
			category TEXT NOT NULL,
			action TEXT NOT NULL,
			resource_type TEXT NOT NULL,
			resource_id TEXT NOT NULL,
			method TEXT NOT NULL,
			path TEXT NOT NULL,
			outcome TEXT NOT NULL,
			status INTEGER NOT NULL,
			duration_ms INTEGER NOT NULL,
			request_id TEXT NOT NULL,
			remote_ip TEXT NOT NULL,
			user_agent TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS audit_event_time_idx ON audit_event(occurred_at DESC, id DESC)`,
		`CREATE INDEX IF NOT EXISTS audit_event_actor_idx ON audit_event(actor_id, occurred_at DESC)`,
		`CREATE INDEX IF NOT EXISTS audit_event_action_idx ON audit_event(action, occurred_at DESC)`,
		`CREATE INDEX IF NOT EXISTS audit_event_resource_idx ON audit_event(resource_type, resource_id, occurred_at DESC)`,
	}
	for _, statement := range statements {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("initialize audit database: %w", err)
		}
	}
	return s.Cleanup(ctx)
}

func (s *Store) Start(ctx context.Context, input Input) (string, error) {
	id, err := randomID()
	if err != nil {
		return "", err
	}
	now := s.now().UTC()
	actor := normalizePrincipal(input.Actor)
	_, err = s.db.ExecContext(ctx, `INSERT INTO audit_event(
		id, occurred_at, actor_id, actor_source, actor_username, actor_display_name, auth_method,
		category, action, resource_type, resource_id, method, path, outcome, status, duration_ms,
		request_id, remote_ip, user_agent
	) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'started',0,0,?,?,?)`, id, now.UnixMilli(), actor.ID, actor.Source,
		actor.Username, actor.DisplayName, actor.AuthMethod, input.Category, input.Action, input.ResourceType,
		input.ResourceID, input.Method, input.Path, input.RequestID, input.RemoteIP, input.UserAgent)
	if err != nil {
		return "", fmt.Errorf("start audit event: %w", err)
	}
	return id, nil
}

func (s *Store) Finish(ctx context.Context, id, outcome string, status int, duration time.Duration) error {
	if id == "" {
		return nil
	}
	finished := s.now().UTC()
	_, err := s.db.ExecContext(ctx, `UPDATE audit_event SET finished_at=?, outcome=?, status=?, duration_ms=? WHERE id=?`,
		finished.UnixMilli(), normalizeOutcome(outcome), status, max(duration.Milliseconds(), 0), id)
	if err != nil {
		return fmt.Errorf("finish audit event: %w", err)
	}
	return nil
}

func (s *Store) Record(ctx context.Context, input Input) error {
	id, err := s.Start(ctx, input)
	if err != nil {
		return err
	}
	return s.Finish(ctx, id, input.Outcome, input.Status, input.Duration)
}

func (s *Store) UpsertOAuthPrincipal(ctx context.Context, provider, subject string, principal Principal) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO oauth_principal(provider, subject, principal_id, username, display_name, updated_at)
		VALUES(?,?,?,?,?,?) ON CONFLICT(provider, subject) DO UPDATE SET username=excluded.username,
		display_name=excluded.display_name, updated_at=excluded.updated_at`, provider, subject, principal.ID,
		principal.Username, principal.DisplayName, s.now().UTC().Unix())
	if err != nil {
		return fmt.Errorf("upsert oauth principal: %w", err)
	}
	return nil
}

func (s *Store) Query(ctx context.Context, filter Filter) (Page, error) {
	filter.Limit = min(max(filter.Limit, 1), 500)
	where := []string{"1=1"}
	args := make([]any, 0, 8)
	if !filter.From.IsZero() {
		where = append(where, "occurred_at>=?")
		args = append(args, filter.From.UnixMilli())
	}
	if !filter.To.IsZero() {
		where = append(where, "occurred_at<=?")
		args = append(args, filter.To.UnixMilli())
	}
	for column, value := range map[string]string{"actor_id": filter.Actor, "action": filter.Action, "outcome": filter.Outcome, "resource_type": filter.ResourceType, "resource_id": filter.ResourceID} {
		if value != "" {
			where = append(where, column+"=?")
			args = append(args, value)
		}
	}
	if millis, id, ok := decodeCursor(filter.Cursor); ok {
		where = append(where, "(occurred_at<? OR (occurred_at=? AND id<?))")
		args = append(args, millis, millis, id)
	}
	args = append(args, filter.Limit+1)
	rows, err := s.db.QueryContext(ctx, `SELECT id, occurred_at, finished_at, actor_id, actor_source,
		actor_username, actor_display_name, auth_method, category, action, resource_type, resource_id,
		method, path, outcome, status, duration_ms, request_id, remote_ip, user_agent FROM audit_event WHERE `+
		strings.Join(where, " AND ")+` ORDER BY occurred_at DESC, id DESC LIMIT ?`, args...)
	if err != nil {
		return Page{}, fmt.Errorf("query audit events: %w", err)
	}
	defer func() { _ = rows.Close() }()
	items := make([]Event, 0, filter.Limit+1)
	for rows.Next() {
		item, err := scanEvent(rows)
		if err != nil {
			return Page{}, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return Page{}, fmt.Errorf("iterate audit events: %w", err)
	}
	page := Page{Items: items}
	if len(page.Items) > filter.Limit {
		page.HasMore = true
		page.Items = page.Items[:filter.Limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor = encodeCursor(last.OccurredAt.UnixMilli(), last.ID)
	}
	return page, nil
}

func (s *Store) Cleanup(ctx context.Context) error {
	if s.retention <= 0 {
		return nil
	}
	cutoff := s.now().UTC().Add(-s.retention).UnixMilli()
	_, err := s.db.ExecContext(ctx, `DELETE FROM audit_event WHERE occurred_at<?`, cutoff)
	if err != nil {
		return fmt.Errorf("clean audit events: %w", err)
	}
	return nil
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

type scanner interface{ Scan(...any) error }

func scanEvent(row scanner) (Event, error) {
	var item Event
	var occurred int64
	var finished sql.NullInt64
	err := row.Scan(&item.ID, &occurred, &finished, &item.Actor.ID, &item.Actor.Source, &item.Actor.Username,
		&item.Actor.DisplayName, &item.Actor.AuthMethod, &item.Category, &item.Action, &item.ResourceType,
		&item.ResourceID, &item.Method, &item.Path, &item.Outcome, &item.Status, &item.DurationMs,
		&item.RequestID, &item.RemoteIP, &item.UserAgent)
	if err != nil {
		return Event{}, fmt.Errorf("scan audit event: %w", err)
	}
	item.OccurredAt = time.UnixMilli(occurred).UTC()
	if finished.Valid {
		value := time.UnixMilli(finished.Int64).UTC()
		item.FinishedAt = &value
	}
	return item, nil
}

func normalizePrincipal(value Principal) Principal {
	if value.ID == "" {
		return PrincipalFromContext(context.Background())
	}
	if value.DisplayName == "" {
		value.DisplayName = value.Username
	}
	return value
}

func normalizeOutcome(value string) string {
	switch value {
	case "success", "denied", "failure", "started":
		return value
	default:
		return "failure"
	}
}

func randomID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}
func encodeCursor(millis int64, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(millis, 10) + "|" + id))
}
func decodeCursor(value string) (int64, string, bool) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return 0, "", false
	}
	parts := strings.SplitN(string(decoded), "|", 2)
	if len(parts) != 2 {
		return 0, "", false
	}
	millis, err := strconv.ParseInt(parts[0], 10, 64)
	return millis, parts[1], err == nil && parts[1] != ""
}
