ALTER TABLE api_token ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
CREATE INDEX api_token_owner_idx ON api_token(owner_id, created_at DESC, id);
