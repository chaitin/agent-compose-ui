package config

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"agent-compose-ui/internal/sharedirs"
)

type AuthMode string

const (
	AuthDisabled AuthMode = "disabled"
	AuthPassword AuthMode = "password"
)

type Config struct {
	ListenAddr, AuthUsername, AuthPassword, AuthSecret string
	AuthMode                                           AuthMode
	SessionTTL                                         time.Duration
	AgentComposeURL, ScriptServiceURL                  *url.URL
	ScriptServiceToken                                 string
	AgentComposeDBPath, UIStateDBPath, TokenDBPath     string
	ProjectStorageRoot, LegacyProjectStorageRoot       string
	LocalVolumeRoot                                    string
	SharedDirectoryCatalog                             []sharedirs.Entry
}

func Load(getenv func(string) string) (Config, error) {
	cfg := Config{ListenAddr: "127.0.0.1:8080", AuthMode: AuthDisabled, AuthUsername: "admin", SessionTTL: 24 * time.Hour}
	if value := strings.TrimSpace(getenv("AUTH_MODE")); value != "" {
		cfg.AuthMode = AuthMode(value)
	}
	if value := strings.TrimSpace(getenv("AUTH_USERNAME")); value != "" {
		cfg.AuthUsername = value
	}
	cfg.AuthPassword, cfg.AuthSecret = getenv("AUTH_PASSWORD"), getenv("AUTH_SECRET")
	if cfg.AuthMode != AuthDisabled && cfg.AuthMode != AuthPassword {
		return Config{}, fmt.Errorf("AUTH_MODE must be disabled or password")
	}
	if cfg.AuthMode == AuthPassword && (cfg.AuthPassword == "" || cfg.AuthSecret == "") {
		return Config{}, fmt.Errorf("AUTH_PASSWORD and AUTH_SECRET are required in password mode")
	}
	if raw := strings.TrimSpace(getenv("AUTH_SESSION_TTL")); raw != "" {
		ttl, err := time.ParseDuration(raw)
		if err != nil || ttl <= 0 {
			return Config{}, fmt.Errorf("AUTH_SESSION_TTL must be a positive duration")
		}
		cfg.SessionTTL = ttl
	}
	parse := func(name, fallback string) (*url.URL, error) {
		raw := strings.TrimSpace(getenv(name))
		if raw == "" {
			raw = fallback
		}
		value, err := url.ParseRequestURI(raw)
		if err != nil || (value.Scheme != "http" && value.Scheme != "https") || value.Host == "" {
			return nil, fmt.Errorf("%s must be an absolute HTTP URL", name)
		}
		return value, nil
	}
	var err error
	if cfg.AgentComposeURL, err = parse("AGENT_COMPOSE_URL", "http://agent-compose:7410"); err != nil {
		return Config{}, err
	}
	if cfg.ScriptServiceURL, err = parse("SCRIPT_SERVICE_URL", "http://scripts:7420"); err != nil {
		return Config{}, err
	}
	cfg.ScriptServiceToken = getenv("SCRIPT_SERVICE_TOKEN")
	if cfg.ScriptServiceToken == "" {
		return Config{}, fmt.Errorf("SCRIPT_SERVICE_TOKEN is required")
	}
	cfg.AgentComposeDBPath = strings.TrimSpace(getenv("AGENT_COMPOSE_DB_PATH"))
	cfg.UIStateDBPath = strings.TrimSpace(getenv("UI_STATE_DB_PATH"))
	cfg.TokenDBPath = strings.TrimSpace(getenv("TOKEN_DB_PATH"))
	if (cfg.AgentComposeDBPath == "") != (cfg.UIStateDBPath == "") {
		return Config{}, fmt.Errorf("AGENT_COMPOSE_DB_PATH and UI_STATE_DB_PATH must be configured together")
	}
	if cfg.AgentComposeDBPath != "" && cfg.AgentComposeDBPath == cfg.UIStateDBPath {
		return Config{}, fmt.Errorf("AGENT_COMPOSE_DB_PATH and UI_STATE_DB_PATH must be different")
	}
	cfg.ProjectStorageRoot = strings.TrimSpace(getenv("PROJECT_STORAGE_ROOT"))
	if cfg.ProjectStorageRoot == "" {
		cfg.ProjectStorageRoot = filepath.Join(os.TempDir(), "agent-compose-ui", "projects")
	}
	cfg.LegacyProjectStorageRoot = strings.TrimSpace(getenv("LEGACY_PROJECT_STORAGE_ROOT"))
	cfg.LocalVolumeRoot = getenv("LOCAL_VOLUME_ROOT")
	cfg.SharedDirectoryCatalog, err = sharedirs.ParseCatalog(getenv("SHARED_DIRECTORY_CATALOG"))
	if err != nil {
		return Config{}, fmt.Errorf("SHARED_DIRECTORY_CATALOG is invalid: %w", err)
	}
	for name, value := range map[string]string{
		"PROJECT_STORAGE_ROOT":        cfg.ProjectStorageRoot,
		"LEGACY_PROJECT_STORAGE_ROOT": cfg.LegacyProjectStorageRoot,
	} {
		if value == "" {
			continue
		}
		if !filepath.IsAbs(value) || filepath.Clean(value) != value {
			return Config{}, fmt.Errorf("%s must be an absolute clean path", name)
		}
	}
	if cfg.LocalVolumeRoot != "" {
		if !validLocalVolumeRoot(cfg.LocalVolumeRoot) || overlapsProtectedPath(cfg.LocalVolumeRoot, cfg) {
			return Config{}, fmt.Errorf("LOCAL_VOLUME_ROOT must be a safe absolute clean path")
		}
	}
	return cfg, nil
}

func validLocalVolumeRoot(value string) bool {
	if len(value) > 4096 || !utf8.ValidString(value) || !filepath.IsAbs(value) || filepath.Clean(value) != value {
		return false
	}
	switch value {
	case "/", "/data", "/var", "/tmp":
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) || unicode.In(r, unicode.Cf) {
			return false
		}
	}
	return true
}

func overlapsProtectedPath(localRoot string, cfg Config) bool {
	protectedDirectories := []string{cfg.ProjectStorageRoot, cfg.LegacyProjectStorageRoot}
	if cfg.AgentComposeDBPath != "" {
		protectedDirectories = append(protectedDirectories, filepath.Dir(cfg.AgentComposeDBPath))
	}
	for _, entry := range cfg.SharedDirectoryCatalog {
		protectedDirectories = append(protectedDirectories, entry.Path)
	}
	for _, protected := range protectedDirectories {
		if protected != "" && pathsOverlap(localRoot, protected) {
			return true
		}
	}

	protectedFiles := []string{cfg.AgentComposeDBPath, cfg.UIStateDBPath, cfg.TokenDBPath}
	for _, protected := range protectedFiles {
		if protected != "" && pathsOverlap(localRoot, protected) {
			return true
		}
	}
	return false
}

func pathsOverlap(left, right string) bool {
	return pathContains(left, right) || pathContains(right, left)
}

func pathContains(root, target string) bool {
	rel, err := filepath.Rel(root, target)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
