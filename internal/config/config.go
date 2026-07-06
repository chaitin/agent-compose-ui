package config

const (
	DefaultListenAddr = "127.0.0.1:8080"
	DefaultBackendURL = "http://agent-compose:7410"
)

type Config struct {
	ListenAddr string
	BackendURL string
}

func LoadFromEnv() Config {
	return Config{
		ListenAddr: DefaultListenAddr,
		BackendURL: DefaultBackendURL,
	}
}
