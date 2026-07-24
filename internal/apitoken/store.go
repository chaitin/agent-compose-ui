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
	db  *sql.DB
	now func() time.Time
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
	store := &Store{db: db, now: time.Now}
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
			expires_at INTEGER,
			revoked_at INTEGER
		)`,
	} {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("initialize token database: %w", err)
		}
	}
	var expiresAtColumns int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM pragma_table_info('api_token') WHERE name='expires_at'`).Scan(&expiresAtColumns); err != nil {
		return fmt.Errorf("inspect token database schema: %w", err)
	}
	if expiresAtColumns == 0 {
		if _, err := s.db.ExecContext(ctx, `ALTER TABLE api_token ADD COLUMN expires_at INTEGER`); err != nil {
			return fmt.Errorf("migrate token database: %w", err)
		}
	}
	return nil
}

func (s *Store) Create(ctx context.Context, name string, role Role, validFor time.Duration) (Created, error) {
	now := s.now().UTC().Truncate(time.Second)
	expiresAt := now.Add(validFor)
	for range createCollisionRetries {
		parsed, raw, err := generateToken()
		if err != nil {
			return Created{}, fmt.Errorf("generate api token: %w", err)
		}
		digest := secretDigest(parsed.secret)
		_, err = s.db.ExecContext(ctx, `INSERT INTO api_token(id, secret_hash, name, role, created_at, expires_at) VALUES(?,?,?,?,?,?)`, parsed.id, digest[:], name, role, now.Unix(), expiresAt.Unix())
		if err == nil {
			return Created{Metadata: Metadata{ID: parsed.id, Name: name, Role: role, CreatedAt: now, ExpiresAt: &expiresAt}, Token: raw}, nil
		}
		if !isUniqueConstraint(err) {
			return Created{}, fmt.Errorf("create api token: %w", err)
		}
	}
	return Created{}, fmt.Errorf("create api token: exhausted public id retries")
}

func (s *Store) List(ctx context.Context) ([]Metadata, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, role, created_at, expires_at, revoked_at FROM api_token ORDER BY created_at DESC, id`)
	if err != nil {
		return nil, fmt.Errorf("list api tokens: %w", err)
	}
	defer func() { _ = rows.Close() }()
	items := make([]Metadata, 0)
	for rows.Next() {
		var item Metadata
		var createdAt int64
		var expiresAt, revokedAt sql.NullInt64
		if err := rows.Scan(&item.ID, &item.Name, &item.Role, &createdAt, &expiresAt, &revokedAt); err != nil {
			return nil, fmt.Errorf("scan api token: %w", err)
		}
		item.CreatedAt = time.Unix(createdAt, 0).UTC()
		if expiresAt.Valid {
			value := time.Unix(expiresAt.Int64, 0).UTC()
			item.ExpiresAt = &value
		}
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
	_, err := s.db.ExecContext(ctx, `UPDATE api_token SET revoked_at=COALESCE(revoked_at, ?) WHERE id=?`, s.now().UTC().Unix(), id)
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
	var expiresAt, revokedAt sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT secret_hash, role, expires_at, revoked_at FROM api_token WHERE id=?`, lookupID).Scan(&digest, &role, &expiresAt, &revokedAt)
	if errors.Is(err, sql.ErrNoRows) {
		digest = dummyDigest[:]
		role = RoleReadOnlyAdmin
	} else if err != nil {
		return Identity{}, fmt.Errorf("authenticate api token: %w", err)
	}
	presented := secretDigest(parsed.secret)
	notExpired := !expiresAt.Valid || expiresAt.Int64 > s.now().UTC().Unix()
	valid := parseErr == nil && !revokedAt.Valid && notExpired && role.Valid() && digestEqual(digest, presented[:])
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
