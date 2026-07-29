CREATE TABLE IF NOT EXISTS oauth_principal (
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(provider, subject)
);

CREATE TABLE IF NOT EXISTS audit_event (
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
);

CREATE INDEX IF NOT EXISTS audit_event_time_idx ON audit_event(occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_event_actor_idx ON audit_event(actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_event_action_idx ON audit_event(action, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_event_resource_idx ON audit_event(resource_type, resource_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS api_token (
    id TEXT PRIMARY KEY,
    secret_hash BLOB NOT NULL CHECK(length(secret_hash) = 32),
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 64),
    role TEXT NOT NULL CHECK(role IN ('admin', 'read-only-admin')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER
);
