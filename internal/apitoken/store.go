package apitoken

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"modernc.org/sqlite"
)

const createCollisionRetries = 5
const sqliteConstraintPrimaryKey = 1555

var dummyDigest = secretDigest("invalid-token-secret")

type Store struct {
	db *sql.DB
}

func OpenStore(path string) (*Store, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("token database path is required")
	}
	db, err := sql.Open("sqlite", filepath.Clean(path))
	if err != nil {
		return nil, fmt.Errorf("open token database: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	store := &Store{db: db}
	if err := store.init(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) init(ctx context.Context) error {
	for _, statement := range []string{
		`PRAGMA journal_mode=WAL`,
		`PRAGMA busy_timeout=5000`,
		`CREATE TABLE IF NOT EXISTS api_token (
			id TEXT PRIMARY KEY,
			secret_hash BLOB NOT NULL CHECK(length(secret_hash) = 32),
			name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 64),
			role TEXT NOT NULL CHECK(role IN ('admin', 'read-only-admin')),
			created_at INTEGER NOT NULL,
			revoked_at INTEGER
		)`,
	} {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("initialize token database: %w", err)
		}
	}
	return nil
}

func (s *Store) Create(ctx context.Context, name string, role Role) (Created, error) {
	now := time.Now().UTC().Truncate(time.Second)
	for range createCollisionRetries {
		parsed, raw, err := generateToken()
		if err != nil {
			return Created{}, fmt.Errorf("generate api token: %w", err)
		}
		digest := secretDigest(parsed.secret)
		_, err = s.db.ExecContext(ctx, `INSERT INTO api_token(id, secret_hash, name, role, created_at) VALUES(?,?,?,?,?)`, parsed.id, digest[:], name, role, now.Unix())
		if err == nil {
			return Created{Metadata: Metadata{ID: parsed.id, Name: name, Role: role, CreatedAt: now}, Token: raw}, nil
		}
		if !isUniqueConstraint(err) {
			return Created{}, fmt.Errorf("create api token: %w", err)
		}
	}
	return Created{}, fmt.Errorf("create api token: exhausted public id retries")
}

func (s *Store) List(ctx context.Context) ([]Metadata, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, role, created_at, revoked_at FROM api_token ORDER BY created_at DESC, id`)
	if err != nil {
		return nil, fmt.Errorf("list api tokens: %w", err)
	}
	defer func() { _ = rows.Close() }()
	items := make([]Metadata, 0)
	for rows.Next() {
		var item Metadata
		var createdAt int64
		var revokedAt sql.NullInt64
		if err := rows.Scan(&item.ID, &item.Name, &item.Role, &createdAt, &revokedAt); err != nil {
			return nil, fmt.Errorf("scan api token: %w", err)
		}
		item.CreatedAt = time.Unix(createdAt, 0).UTC()
		if revokedAt.Valid {
			value := time.Unix(revokedAt.Int64, 0).UTC()
			item.RevokedAt = &value
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate api tokens: %w", err)
	}
	return items, nil
}

func (s *Store) Revoke(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE api_token SET revoked_at=COALESCE(revoked_at, ?) WHERE id=?`, time.Now().UTC().Unix(), id)
	if err != nil {
		return fmt.Errorf("revoke api token: %w", err)
	}
	return nil
}

func (s *Store) Authenticate(ctx context.Context, raw string) (Identity, error) {
	parsed, parseErr := parseToken(raw)
	lookupID := parsed.id
	if parseErr != nil {
		lookupID = strings.Repeat("0", publicIDHexLength)
	}
	var digest []byte
	var role Role
	var revokedAt sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT secret_hash, role, revoked_at FROM api_token WHERE id=?`, lookupID).Scan(&digest, &role, &revokedAt)
	if errors.Is(err, sql.ErrNoRows) {
		digest = dummyDigest[:]
		role = RoleReadOnlyAdmin
	} else if err != nil {
		return Identity{}, fmt.Errorf("authenticate api token: %w", err)
	}
	presented := secretDigest(parsed.secret)
	valid := parseErr == nil && !revokedAt.Valid && role.Valid() && digestEqual(digest, presented[:])
	if !valid {
		return Identity{}, ErrInvalidToken
	}
	return Identity{ID: parsed.id, Role: role}, nil
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func isUniqueConstraint(err error) bool {
	var sqliteErr *sqlite.Error
	return errors.As(err, &sqliteErr) && sqliteErr.Code() == sqliteConstraintPrimaryKey
}
