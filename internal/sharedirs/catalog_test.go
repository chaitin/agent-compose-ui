package sharedirs

import (
	"strings"
	"testing"
)

func TestParseCatalogValidAndPreservesOrder(t *testing.T) {
	raw := `[{"id":"reference","name":"参考资料","path":"/shares/reference","writable":false},{"id":"work-1","name":"Work","path":"/mnt/work","writable":true}]`
	got, err := ParseCatalog(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].ID != "reference" || got[1].ID != "work-1" || !got[1].Writable {
		t.Fatalf("entries = %#v", got)
	}
}

func TestParseCatalogDefaultsOmittedWritableToReadOnly(t *testing.T) {
	got, err := ParseCatalog(`[{"id":"reference","name":"Reference","path":"/shares/reference"}]`)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Writable {
		t.Fatalf("entries = %#v", got)
	}
}

func TestParseCatalogEmpty(t *testing.T) {
	for _, raw := range []string{"", " \n\t"} {
		got, err := ParseCatalog(raw)
		if err != nil || len(got) != 0 {
			t.Fatalf("ParseCatalog(%q) = %#v, %v", raw, got, err)
		}
	}
}

func TestParseCatalogRejectsUnsafeOrMalformedInput(t *testing.T) {
	tests := map[string]string{
		"invalid JSON": `{`, "trailing JSON": `[] []`, "non-array": `{}`,
		"unknown field":      `[{"id":"a","name":"A","path":"/shares/a","extra":1}]`,
		"duplicate field":    `[{"id":"a","id":"b","name":"A","path":"/shares/a"}]`,
		"bad writable type":  `[{"id":"a","name":"A","path":"/shares/a","writable":"yes"}]`,
		"duplicate id":       `[{"id":"a","name":"A","path":"/shares/a"},{"id":"a","name":"B","path":"/shares/b"}]`,
		"duplicate path":     `[{"id":"a","name":"A","path":"/shares/a"},{"id":"b","name":"B","path":"/shares/a"}]`,
		"relative path":      `[{"id":"a","name":"A","path":"shares/a"}]`,
		"unclean path":       `[{"id":"a","name":"A","path":"/shares/../secret"}]`,
		"root":               `[{"id":"a","name":"A","path":"/"}]`,
		"data subtree":       `[{"id":"a","name":"A","path":"/data/projects"}]`,
		"proc subtree":       `[{"id":"a","name":"A","path":"/proc/1"}]`,
		"docker socket":      `[{"id":"a","name":"A","path":"/var/run/docker.sock"}]`,
		"backslash":          `[{"id":"a","name":"A","path":"/shares\\a"}]`,
		"invalid id":         `[{"id":"A space","name":"A","path":"/shares/a"}]`,
		"blank name":         `[{"id":"a","name":"  ","path":"/shares/a"}]`,
		"control name":       "[{\"id\":\"a\",\"name\":\"A\\u0001\",\"path\":\"/shares/a\"}]",
		"C1 control name":    "[{\"id\":\"a\",\"name\":\"A\\u0085\",\"path\":\"/shares/a\"}]",
		"C1 control path":    "[{\"id\":\"a\",\"name\":\"A\",\"path\":\"/shares/a\\u009f\"}]",
		"bidi override name": "[{\"id\":\"a\",\"name\":\"A\\u202eB\",\"path\":\"/shares/a\"}]",
		"bidi isolate path":  "[{\"id\":\"a\",\"name\":\"A\",\"path\":\"/shares/\\u2066a\\u2069\"}]",
		"zero width name":    "[{\"id\":\"a\",\"name\":\"A\\u200bB\",\"path\":\"/shares/a\"}]",
	}
	for name, raw := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseCatalog(raw); err == nil {
				t.Fatalf("ParseCatalog(%s) succeeded", raw)
			}
		})
	}
	if _, err := ParseCatalog(string([]byte{'[', 0xff, ']'})); err == nil || !strings.Contains(err.Error(), "UTF-8") {
		t.Fatalf("invalid UTF-8 error = %v", err)
	}
}

func TestParseCatalogErrorsDoNotExposeConfiguredPaths(t *testing.T) {
	secret := "/shares/customer-secret-path"
	_, err := ParseCatalog(`[{"id":"a","name":"First","path":"` + secret + `"},{"id":"b","name":"Second","path":"` + secret + `"}]`)
	if err == nil {
		t.Fatal("duplicate path succeeded")
	}
	if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "First") || strings.Contains(err.Error(), "Second") {
		t.Fatalf("error exposes configured value: %q", err)
	}
}

func TestValidateSelection(t *testing.T) {
	entries, err := ParseCatalog(`[{"id":"ro","name":"Read only","path":"/shares/ro"},{"id":"rw","name":"Writable","path":"/shares/rw","writable":true}]`)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := ValidateSelection(entries, "rw", true); err != nil || got.ID != "rw" {
		t.Fatalf("rw = %#v, %v", got, err)
	}
	if _, err := ValidateSelection(entries, "ro", true); err == nil {
		t.Fatal("read-only escalation succeeded")
	}
	if _, err := ValidateSelection(entries, "missing", false); err == nil {
		t.Fatal("unknown ID succeeded")
	}
}

func TestValidateSelectionRejectsUnsafeProgrammaticEntries(t *testing.T) {
	tests := map[string]struct {
		entries []Entry
		id      string
	}{
		"restricted path": {entries: []Entry{{ID: "selected", Name: "Selected", Path: "/data/private"}}, id: "selected"},
		"invalid id":      {entries: []Entry{{ID: "Selected", Name: "Selected", Path: "/shares/selected"}}, id: "Selected"},
		"control name":    {entries: []Entry{{ID: "selected", Name: "Selected\u0085", Path: "/shares/selected"}}, id: "selected"},
		"format name":     {entries: []Entry{{ID: "selected", Name: "Selec\u202eted", Path: "/shares/selected"}}, id: "selected"},
		"format path":     {entries: []Entry{{ID: "selected", Name: "Selected", Path: "/shares/\u200bselected"}}, id: "selected"},
		"invalid later": {entries: []Entry{
			{ID: "selected", Name: "Selected", Path: "/shares/selected"},
			{ID: "unsafe", Name: "Unsafe", Path: "/data/private"},
		}, id: "selected"},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := ValidateSelection(test.entries, test.id, false); err == nil {
				t.Fatal("unsafe selection succeeded")
			}
		})
	}
}

func TestValidateSelectionRejectsProgrammaticDuplicateCatalog(t *testing.T) {
	secretPath := "/shares/customer-secret"
	tests := map[string][]Entry{
		"duplicate id with conflicting capability": {
			{ID: "selected", Name: "Read only", Path: "/shares/read-only"},
			{ID: "selected", Name: "Writable", Path: "/shares/writable", Writable: true},
		},
		"duplicate path": {
			{ID: "selected", Name: "Selected", Path: secretPath},
			{ID: "other", Name: "Other", Path: secretPath},
		},
	}
	for name, entries := range tests {
		t.Run(name, func(t *testing.T) {
			_, err := ValidateSelection(entries, "selected", false)
			if err == nil {
				t.Fatal("duplicate catalog succeeded")
			}
			if strings.Contains(err.Error(), secretPath) || strings.Contains(err.Error(), "Selected") || strings.Contains(err.Error(), "Other") {
				t.Fatalf("error exposes configured value: %q", err)
			}
		})
	}
}
