package projectenv

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	_ "modernc.org/sqlite"
)

type ShadowProject struct {
	ProjectID      string
	SourcePath     string
	SpecJSON       string
	DaemonSpecHash string
	References     []string
	PendingSync    bool
}

type ShadowStore struct {
	db *sql.DB
}

func OpenShadowStore(path string) (*ShadowStore, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("shadow database path is required")
	}
	db, err := sql.Open("sqlite", filepath.Clean(path))
	if err != nil {
		return nil, fmt.Errorf("open shadow database: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	store := &ShadowStore{db: db}
	if err := store.init(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *ShadowStore) SaveApplied(ctx context.Context, project ShadowProject) error {
	project.ProjectID = strings.TrimSpace(project.ProjectID)
	if project.ProjectID == "" {
		return fmt.Errorf("shadow project id is required")
	}
	if !json.Valid([]byte(project.SpecJSON)) {
		return fmt.Errorf("shadow project spec must be valid JSON")
	}
	references := normalizeNames(project.References)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin shadow save: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	_, err = tx.ExecContext(ctx, `INSERT INTO shadow_project(project_id,source_path,spec_json,daemon_spec_hash,pending_sync)
		VALUES(?,?,?,?,0)
		ON CONFLICT(project_id) DO UPDATE SET source_path=excluded.source_path,spec_json=excluded.spec_json,
		daemon_spec_hash=excluded.daemon_spec_hash,pending_sync=0`,
		project.ProjectID, project.SourcePath, project.SpecJSON, project.DaemonSpecHash)
	if err != nil {
		return fmt.Errorf("save shadow project: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM shadow_reference WHERE project_id=?`, project.ProjectID); err != nil {
		return fmt.Errorf("replace shadow references: %w", err)
	}
	for _, name := range references {
		if _, err := tx.ExecContext(ctx, `INSERT INTO shadow_reference(project_id,name) VALUES(?,?)`, project.ProjectID, name); err != nil {
			return fmt.Errorf("save shadow reference: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit shadow save: %w", err)
	}
	return nil
}

func (s *ShadowStore) Get(ctx context.Context, projectID string) (ShadowProject, bool, error) {
	projectID = strings.TrimSpace(projectID)
	var project ShadowProject
	var pending int
	err := s.db.QueryRowContext(ctx, `SELECT project_id,source_path,spec_json,daemon_spec_hash,pending_sync
		FROM shadow_project WHERE project_id=?`, projectID).Scan(
		&project.ProjectID, &project.SourcePath, &project.SpecJSON, &project.DaemonSpecHash, &pending)
	if err == sql.ErrNoRows {
		return ShadowProject{}, false, nil
	}
	if err != nil {
		return ShadowProject{}, false, fmt.Errorf("get shadow project: %w", err)
	}
	project.PendingSync = pending != 0
	rows, err := s.db.QueryContext(ctx, `SELECT name FROM shadow_reference WHERE project_id=? ORDER BY name`, projectID)
	if err != nil {
		return ShadowProject{}, false, fmt.Errorf("get shadow references: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return ShadowProject{}, false, fmt.Errorf("scan shadow reference: %w", err)
		}
		project.References = append(project.References, name)
	}
	if err := rows.Err(); err != nil {
		return ShadowProject{}, false, fmt.Errorf("iterate shadow references: %w", err)
	}
	return project, true, nil
}

func (s *ShadowStore) MarkReferencesPending(ctx context.Context, names []string) ([]string, error) {
	names = normalizeNames(names)
	if len(names) == 0 {
		return nil, nil
	}
	placeholders := strings.TrimRight(strings.Repeat("?,", len(names)), ",")
	args := make([]any, len(names))
	for i, name := range names {
		args[i] = name
	}
	query := `SELECT DISTINCT project_id FROM shadow_reference WHERE name IN (` + placeholders + `) ORDER BY project_id`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("find dependent shadow projects: %w", err)
	}
	var projectIDs []string
	for rows.Next() {
		var projectID string
		if err := rows.Scan(&projectID); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("scan dependent shadow project: %w", err)
		}
		projectIDs = append(projectIDs, projectID)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close dependent shadow projects: %w", err)
	}
	if len(projectIDs) == 0 {
		return nil, nil
	}
	projectPlaceholders := strings.TrimRight(strings.Repeat("?,", len(projectIDs)), ",")
	projectArgs := make([]any, len(projectIDs))
	for i, projectID := range projectIDs {
		projectArgs[i] = projectID
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE shadow_project SET pending_sync=1 WHERE project_id IN (`+projectPlaceholders+`)`, projectArgs...); err != nil {
		return nil, fmt.Errorf("mark shadow projects pending: %w", err)
	}
	return projectIDs, nil
}

func (s *ShadowStore) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *ShadowStore) init(ctx context.Context) error {
	statements := []string{
		`PRAGMA foreign_keys=ON`,
		`CREATE TABLE IF NOT EXISTS shadow_project (
			project_id TEXT PRIMARY KEY,
			source_path TEXT NOT NULL DEFAULT '',
			spec_json TEXT NOT NULL,
			daemon_spec_hash TEXT NOT NULL DEFAULT '',
			pending_sync INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS shadow_reference (
			project_id TEXT NOT NULL REFERENCES shadow_project(project_id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			PRIMARY KEY(project_id,name)
		)`,
		`CREATE INDEX IF NOT EXISTS shadow_reference_name ON shadow_reference(name)`,
	}
	for _, statement := range statements {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("initialize shadow database: %w", err)
		}
	}
	return nil
}

func normalizeNames(names []string) []string {
	unique := make(map[string]struct{}, len(names))
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name != "" {
			unique[name] = struct{}{}
		}
	}
	result := make([]string, 0, len(unique))
	for name := range unique {
		result = append(result, name)
	}
	sort.Strings(result)
	return result
}
