package projectenv

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"
)

func TestShadowStoreSaveGetAndMarkPending(t *testing.T) {
	store, err := OpenShadowStore(filepath.Join(t.TempDir(), "shadow.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	ctx := context.Background()
	project := ShadowProject{
		ProjectID:      "project-a",
		SourcePath:     "/projects/a/agent-compose.yml",
		SpecJSON:       `{"name":"a","variables":[{"name":"TOKEN","value":"${TOKEN}"}]}`,
		DaemonSpecHash: "sha256:first",
		References:     []string{"TOKEN", "TOKEN", "HOST"},
		PendingSync:    true,
	}
	if err := store.SaveApplied(ctx, project); err != nil {
		t.Fatal(err)
	}
	got, found, err := store.Get(ctx, "project-a")
	if err != nil || !found {
		t.Fatalf("Get found=%v err=%v", found, err)
	}
	project.References = []string{"HOST", "TOKEN"}
	project.PendingSync = false
	if !reflect.DeepEqual(got, project) {
		t.Fatalf("project = %#v, want %#v", got, project)
	}

	if err := store.SaveApplied(ctx, ShadowProject{
		ProjectID: "project-b", SpecJSON: `{"name":"b"}`, References: []string{"OTHER"},
	}); err != nil {
		t.Fatal(err)
	}
	affected, err := store.MarkReferencesPending(ctx, []string{"TOKEN"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(affected, []string{"project-a"}) {
		t.Fatalf("affected = %#v", affected)
	}
	after, _, _ := store.Get(ctx, "project-a")
	if !after.PendingSync {
		t.Fatal("project-a is not pending")
	}
	unaffected, _, _ := store.Get(ctx, "project-b")
	if unaffected.PendingSync {
		t.Fatal("project-b unexpectedly pending")
	}
}

func TestShadowStoreSaveAppliedReplacesReferencesAndClearsPending(t *testing.T) {
	store, err := OpenShadowStore(filepath.Join(t.TempDir(), "shadow.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	ctx := context.Background()
	if err := store.SaveApplied(ctx, ShadowProject{ProjectID: "p", SpecJSON: `{}`, References: []string{"OLD"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MarkReferencesPending(ctx, []string{"OLD"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveApplied(ctx, ShadowProject{ProjectID: "p", SpecJSON: `{"updated":true}`, References: []string{"NEW"}}); err != nil {
		t.Fatal(err)
	}
	got, _, err := store.Get(ctx, "p")
	if err != nil {
		t.Fatal(err)
	}
	if got.PendingSync || !reflect.DeepEqual(got.References, []string{"NEW"}) {
		t.Fatalf("updated project = %#v", got)
	}
	if affected, err := store.MarkReferencesPending(ctx, []string{"OLD"}); err != nil || len(affected) != 0 {
		t.Fatalf("old reference affected=%#v err=%v", affected, err)
	}
}
