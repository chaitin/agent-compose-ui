package projectenv

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

var referencePattern = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)

type GlobalValue struct {
	Value  string
	Secret bool
}

type ReferenceWarning struct {
	Path string
	Name string
}

type ResolveResult struct {
	Spec       map[string]any
	References []string
	Warnings   []ReferenceWarning
}

func ResolveSpec(spec map[string]any, globals map[string]GlobalValue) (ResolveResult, error) {
	cloned, ok := cloneJSON(spec).(map[string]any)
	if !ok {
		return ResolveResult{}, fmt.Errorf("project spec must be an object")
	}
	state := resolveState{globals: globals, references: make(map[string]struct{})}
	state.resolveValue(cloned, "")
	references := make([]string, 0, len(state.references))
	for name := range state.references {
		references = append(references, name)
	}
	sort.Strings(references)
	return ResolveResult{Spec: cloned, References: references, Warnings: state.warnings}, nil
}

type resolveState struct {
	globals    map[string]GlobalValue
	references map[string]struct{}
	warnings   []ReferenceWarning
}

func (s *resolveState) resolveValue(value any, path string) {
	switch typed := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			if key == "script" {
				continue
			}
			fieldPath := joinPath(path, key)
			if text, ok := typed[key].(string); ok {
				resolved, secret := s.resolveString(text, fieldPath)
				typed[key] = resolved
				if key == "value" && secret {
					typed["secret"] = true
				}
				continue
			}
			s.resolveValue(typed[key], fieldPath)
		}
	case []any:
		for index, item := range typed {
			itemPath := fmt.Sprintf("%s[%d]", path, index)
			if object, ok := item.(map[string]any); ok {
				itemPath = joinPath(path, itemName(object, index))
			}
			if text, ok := item.(string); ok {
				typed[index], _ = s.resolveString(text, itemPath)
				continue
			}
			s.resolveValue(item, itemPath)
		}
	}
}

func (s *resolveState) resolveString(text, path string) (string, bool) {
	secret := false
	resolved := referencePattern.ReplaceAllStringFunc(text, func(match string) string {
		parts := referencePattern.FindStringSubmatch(match)
		reference := parts[1]
		global, found := s.globals[reference]
		if !found {
			s.warnings = append(s.warnings, ReferenceWarning{Path: path, Name: reference})
			return match
		}
		s.references[reference] = struct{}{}
		secret = secret || global.Secret
		return global.Value
	})
	return resolved, secret
}

func joinPath(parent, child string) string {
	if parent == "" {
		return child
	}
	return parent + "." + child
}

func itemName(item map[string]any, fallback int) string {
	if name, ok := item["name"].(string); ok && strings.TrimSpace(name) != "" {
		return strings.TrimSpace(name)
	}
	return fmt.Sprintf("[%d]", fallback)
}

func cloneJSON(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			result[key] = cloneJSON(item)
		}
		return result
	case []any:
		result := make([]any, len(typed))
		for i, item := range typed {
			result[i] = cloneJSON(item)
		}
		return result
	default:
		return value
	}
}
