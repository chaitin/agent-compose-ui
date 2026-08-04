package config

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func env(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestLoadDefaultsToDisabledInternalMode(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"AGENT_COMPOSE_URL":    "http://agent-compose:7410",
		"SCRIPT_SERVICE_URL":   "http://scripts:7420",
		"SCRIPT_SERVICE_TOKEN": "token",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AuthMode != AuthDisabled || cfg.ListenAddr != "127.0.0.1:8080" || cfg.SessionTTL != 24*time.Hour {
		t.Fatalf("unexpected config: %#v", cfg)
	}
}

func TestLoadPasswordModeRequiresSecrets(t *testing.T) {
	_, err := Load(env(map[string]string{
		"AUTH_MODE":            "password",
		"AUTH_PASSWORD":        "",
		"AUTH_SECRET":          "",
		"AGENT_COMPOSE_URL":    "http://agent-compose:7410",
		"SCRIPT_SERVICE_URL":   "http://scripts:7420",
		"SCRIPT_SERVICE_TOKEN": "token",
	}))
	if err == nil {
		t.Fatal("expected password configuration error")
	}
}

func TestLoadRejectsInvalidModeDurationAndUpstreams(t *testing.T) {
	cases := []map[string]string{
		{"AUTH_MODE": "other"},
		{"AUTH_SESSION_TTL": "zero"},
		{"AGENT_COMPOSE_URL": "://bad"},
		{"SCRIPT_SERVICE_URL": "://bad"},
		{"AGENT_COMPOSE_URL": "ftp://agent-compose:7410"},
		{"SCRIPT_SERVICE_URL": "unix://scripts"},
	}
	for _, values := range cases {
		values["SCRIPT_SERVICE_TOKEN"] = "token"
		if _, err := Load(env(values)); err == nil {
			t.Fatalf("expected error for %#v", values)
		}
	}
}

func TestLoadProjectEnvironmentPaths(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"SCRIPT_SERVICE_TOKEN":  "token",
		"AGENT_COMPOSE_DB_PATH": "/data/agent-compose/data.db",
		"UI_STATE_DB_PATH":      "/data/ui/project-env.db",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AgentComposeDBPath != "/data/agent-compose/data.db" || cfg.UIStateDBPath != "/data/ui/project-env.db" {
		t.Fatalf("paths = %#v", cfg)
	}
	for _, values := range []map[string]string{
		{"AGENT_COMPOSE_DB_PATH": "/data/data.db"},
		{"UI_STATE_DB_PATH": "/data/ui.db"},
		{"AGENT_COMPOSE_DB_PATH": "/same.db", "UI_STATE_DB_PATH": "/same.db"},
	} {
		values["SCRIPT_SERVICE_TOKEN"] = "token"
		if _, err := Load(env(values)); err == nil {
			t.Fatalf("expected path error for %#v", values)
		}
	}
}

func TestLoadTokenDatabasePathIsOptional(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"SCRIPT_SERVICE_TOKEN": "token",
		"TOKEN_DB_PATH":        " /data/api/tokens.db ",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.TokenDBPath != "/data/api/tokens.db" {
		t.Fatalf("TokenDBPath = %q", cfg.TokenDBPath)
	}

	cfg, err = Load(env(map[string]string{"SCRIPT_SERVICE_TOKEN": "token"}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.TokenDBPath != "" {
		t.Fatalf("TokenDBPath = %q, want empty", cfg.TokenDBPath)
	}
}

func TestLoadProjectStoragePaths(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"SCRIPT_SERVICE_TOKEN":        "token",
		"PROJECT_STORAGE_ROOT":        "/data/work/projects",
		"LEGACY_PROJECT_STORAGE_ROOT": "/legacy/projects",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ProjectStorageRoot != "/data/work/projects" || cfg.LegacyProjectStorageRoot != "/legacy/projects" {
		t.Fatalf("storage paths = %#v", cfg)
	}
}

func TestLoadDefaultsProjectStorageToTemp(t *testing.T) {
	tempRoot := t.TempDir()
	t.Setenv("TMPDIR", tempRoot)
	cfg, err := Load(env(map[string]string{"SCRIPT_SERVICE_TOKEN": "token"}))
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(tempRoot, "agent-compose-ui", "projects")
	if cfg.ProjectStorageRoot != want {
		t.Fatalf("default project storage root = %q, want %q", cfg.ProjectStorageRoot, want)
	}
}

func TestLoadRejectsRelativeProjectStoragePaths(t *testing.T) {
	for _, values := range []map[string]string{
		{"PROJECT_STORAGE_ROOT": "relative/projects"},
		{"LEGACY_PROJECT_STORAGE_ROOT": "legacy/projects"},
	} {
		values["SCRIPT_SERVICE_TOKEN"] = "token"
		if _, err := Load(env(values)); err == nil {
			t.Fatalf("expected path error for %#v", values)
		}
	}
}

func TestLoadSharedDirectoryCatalog(t *testing.T) {
	cfg, err := Load(env(map[string]string{"SCRIPT_SERVICE_TOKEN": "token", "SHARED_DIRECTORY_CATALOG": `[{"id":"reference","name":"Reference","path":"/shares/reference"}]`}))
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.SharedDirectoryCatalog) != 1 || cfg.SharedDirectoryCatalog[0].ID != "reference" {
		t.Fatalf("catalog = %#v", cfg.SharedDirectoryCatalog)
	}
}

func TestLoadRejectsInvalidSharedDirectoryCatalog(t *testing.T) {
	_, err := Load(env(map[string]string{"SCRIPT_SERVICE_TOKEN": "token", "SHARED_DIRECTORY_CATALOG": `[{"id":"bad","name":"Bad","path":"/data"}]`}))
	if err == nil {
		t.Fatal("Load succeeded")
	}
}

func TestLoadLocalVolumeRoot(t *testing.T) {
	t.Run("disabled when unset or empty", func(t *testing.T) {
		for _, value := range []string{unsetValue, ""} {
			values := map[string]string{"SCRIPT_SERVICE_TOKEN": "token"}
			if value != unsetValue {
				values["LOCAL_VOLUME_ROOT"] = value
			}
			cfg, err := Load(env(values))
			if err != nil {
				t.Fatal(err)
			}
			if cfg.LocalVolumeRoot != "" {
				t.Fatalf("LocalVolumeRoot = %q, want disabled", cfg.LocalVolumeRoot)
			}
		}
	})

	t.Run("accepts approved deployment root", func(t *testing.T) {
		cfg, err := Load(env(map[string]string{
			"SCRIPT_SERVICE_TOKEN":  "token",
			"LOCAL_VOLUME_ROOT":     "/data/volumes/local",
			"PROJECT_STORAGE_ROOT":  "/data/work/projects",
			"AGENT_COMPOSE_DB_PATH": "/data/agent-compose/data.db",
			"UI_STATE_DB_PATH":      "/data/ui/project-env.db",
		}))
		if err != nil {
			t.Fatal(err)
		}
		if cfg.LocalVolumeRoot != "/data/volumes/local" {
			t.Fatalf("LocalVolumeRoot = %q", cfg.LocalVolumeRoot)
		}
	})
}

const unsetValue = "<unset>"

func TestLoadRejectsUnsafeLocalVolumeRoot(t *testing.T) {
	cases := []string{
		"relative/volumes",
		"/data/volumes/../local",
		"/data//volumes/local",
		"/data/volumes/local/",
		"/",
		"/data",
		"/var",
		"/tmp",
		"/data/volumes/\x00local",
		"/data/volumes/\nlocal",
		"/data/volumes/\u202elocal",
		"/data/volumes/" + string([]byte{0xff}),
		"/data/volumes/" + strings.Repeat("x", 4096),
	}
	for _, root := range cases {
		t.Run(strings.ReplaceAll(root, "/", "_"), func(t *testing.T) {
			_, err := Load(env(map[string]string{
				"SCRIPT_SERVICE_TOKEN": "token",
				"LOCAL_VOLUME_ROOT":    root,
			}))
			if err == nil {
				t.Fatalf("Load accepted unsafe local volume root")
			}
			if strings.Contains(err.Error(), root) {
				t.Fatalf("error leaks configured path: %v", err)
			}
		})
	}
}

func TestLoadRejectsLocalVolumeRootContainingProtectedStorage(t *testing.T) {
	for name, values := range map[string]map[string]string{
		"project root": {
			"LOCAL_VOLUME_ROOT":    "/data/work",
			"PROJECT_STORAGE_ROOT": "/data/work/projects",
		},
		"daemon data root": {
			"LOCAL_VOLUME_ROOT":     "/srv/agent-data",
			"AGENT_COMPOSE_DB_PATH": "/srv/agent-data/agent-compose/data.db",
			"UI_STATE_DB_PATH":      "/data/ui/project-env.db",
		},
	} {
		t.Run(name, func(t *testing.T) {
			values["SCRIPT_SERVICE_TOKEN"] = "token"
			if _, err := Load(env(values)); err == nil {
				t.Fatal("Load accepted overlapping local volume root")
			}
		})
	}
}

func TestLoadLocalVolumeRootProtectedPathOverlap(t *testing.T) {
	rejected := map[string]map[string]string{
		"equals project root": {
			"LOCAL_VOLUME_ROOT":    "/srv/projects",
			"PROJECT_STORAGE_ROOT": "/srv/projects",
		},
		"contains project root": {
			"LOCAL_VOLUME_ROOT":    "/srv/tenant",
			"PROJECT_STORAGE_ROOT": "/srv/tenant/projects",
		},
		"is inside project root": {
			"LOCAL_VOLUME_ROOT":    "/srv/projects/volumes",
			"PROJECT_STORAGE_ROOT": "/srv/projects",
		},
		"is inside legacy project root": {
			"LOCAL_VOLUME_ROOT":           "/srv/legacy/volumes",
			"PROJECT_STORAGE_ROOT":        "/srv/projects",
			"LEGACY_PROJECT_STORAGE_ROOT": "/srv/legacy",
		},
		"is inside shared directory root": {
			"LOCAL_VOLUME_ROOT":        "/shares/reference/volumes",
			"PROJECT_STORAGE_ROOT":     "/srv/projects",
			"SHARED_DIRECTORY_CATALOG": `[{"id":"reference","name":"Reference","path":"/shares/reference"}]`,
		},
		"is inside daemon database directory": {
			"LOCAL_VOLUME_ROOT":     "/srv/daemon/volumes",
			"PROJECT_STORAGE_ROOT":  "/srv/projects",
			"AGENT_COMPOSE_DB_PATH": "/srv/daemon/data.db",
			"UI_STATE_DB_PATH":      "/srv/ui/state.db",
		},
		"contains UI state file": {
			"LOCAL_VOLUME_ROOT":     "/srv/ui",
			"PROJECT_STORAGE_ROOT":  "/srv/projects",
			"AGENT_COMPOSE_DB_PATH": "/srv/daemon/data.db",
			"UI_STATE_DB_PATH":      "/srv/ui/state.db",
		},
		"contains token database file": {
			"LOCAL_VOLUME_ROOT":    "/srv/tokens",
			"PROJECT_STORAGE_ROOT": "/srv/projects",
			"TOKEN_DB_PATH":        "/srv/tokens/tokens.db",
		},
	}
	for name, values := range rejected {
		t.Run(name, func(t *testing.T) {
			values["SCRIPT_SERVICE_TOKEN"] = "token"
			_, err := Load(env(values))
			if err == nil {
				t.Fatal("Load accepted overlapping local volume root")
			}
			if strings.Contains(err.Error(), values["LOCAL_VOLUME_ROOT"]) {
				t.Fatalf("error leaks configured path: %v", err)
			}
		})
	}
}

func TestLoadLocalVolumeRootAllowsBoundaryAwareSiblings(t *testing.T) {
	for name, values := range map[string]map[string]string{
		"ordinary siblings": {
			"LOCAL_VOLUME_ROOT":     "/srv/volumes",
			"PROJECT_STORAGE_ROOT":  "/srv/projects",
			"AGENT_COMPOSE_DB_PATH": "/srv/daemon/data.db",
			"UI_STATE_DB_PATH":      "/srv/ui/state.db",
			"TOKEN_DB_PATH":         "/srv/tokens/tokens.db",
		},
		"prefix boundary": {
			"LOCAL_VOLUME_ROOT":    "/srv/data2",
			"PROJECT_STORAGE_ROOT": "/srv/data",
		},
	} {
		t.Run(name, func(t *testing.T) {
			values["SCRIPT_SERVICE_TOKEN"] = "token"
			if _, err := Load(env(values)); err != nil {
				t.Fatal(err)
			}
		})
	}
}
