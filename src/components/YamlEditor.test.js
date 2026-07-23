import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./YamlEditor.svelte', import.meta.url), 'utf8');

test('renders script references as clickable Monaco links', () => {
  expect(source).toContain('listScriptRanges(store.editorContent)');
  expect(source).toContain("inlineClassName: 'script-ref-link'");
  expect(source).toContain('deltaDecorations');
  expect(source).toContain('打开脚本文件');
});

test('renders state-aware actions for inline scripts', () => {
  expect(source).toContain('ScriptLineActions');
  expect(source).toContain('empty:');
  expect(source).toContain('onMode:');
  expect(source).toContain('initializeInlineScript');
  expect(source).toContain('onExtract:');
  expect(source).toContain('onReference:');
  expect(source).toContain('onInline:');
});

test('only opens the reference picker for an empty inline script', () => {
  expect(source).toContain('function isEmptyInlineScript');
  expect(source).toContain('if (!range || range.kind !== \'inline\' || !isEmptyInlineScript(range))');
  expect(source).toContain("'只有空的 script 才能引用已有文件'");
  expect(source).toContain("createContextKey('scriptInlineEmpty'");
  expect(source).toContain("precondition: 'scriptInlineEmpty'");
  expect(source).toContain("precondition: 'scriptInlinePopulated'");
});

test('creates extracted files through the workspace flow', () => {
  expect(source).toContain('await scriptWorkspace.writeFileForce(path, extracted.content)');
  expect(source).not.toContain('scriptApi.writeFile({ path, content: extracted.content');
});

test('pins line actions to the editor viewport right edge', () => {
  expect(source).toContain('const ACTION_RIGHT_GAP = 12');
  expect(source).toContain('target.getLayoutInfo()');
  expect(source).toContain('node.offsetWidth');
  expect(source).toContain('Math.max(0, availableWidth - widgetWidth)');
  expect(source).toContain('onDidScrollChange');
  expect(source).toContain('onDidLayoutChange');
  expect(source).toContain('layoutContentWidget');
});

test('constrains line actions to the visible editor content width', () => {
  expect(source).toContain('column: 1');
  expect(source).not.toContain('column: model.getLineMaxColumn(range.startLine)');
  expect(source).toContain('const availableWidth = Math.max(0, viewportRight - layout.contentLeft)');
  expect(source).toContain('node.style.maxWidth = `${availableWidth}px`');
  expect(source).toContain('Math.min(node.offsetWidth, availableWidth)');
});

test('uses the reference modal instead of browser prompts', () => {
  expect(source).toContain('ScriptReferenceModal');
  expect(source).not.toContain('window.prompt');
  expect(source).toContain('defaultScriptPath');
});

test('does not subscribe the Monaco initialization effect to editor content', () => {
  expect(source).toMatch(/editor = e;\s*untrack\(\(\) => \{\s*updateScriptActionContext\(\);\s*refreshScriptPresentation\(e\);\s*refreshWorkspacePresentation\(e\);\s*\}\);/);
});

test('restores only viewport primitives after external content replacement', () => {
  expect(source).not.toContain('saveViewState()');
  expect(source).not.toContain('restoreViewState(');
  expect(source).toContain('editor.getScrollTop()');
  expect(source).toContain('editor.getScrollLeft()');
  expect(source).toContain('editor.getSelections()');
  expect(source).toContain('editor.setSelections(selections)');
  expect(source).toContain('editor.setScrollPosition({ scrollTop, scrollLeft })');
});

test('registers a concrete Monaco editor worker', () => {
  expect(source).toContain("import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'");
  expect(source).toContain('self.MonacoEnvironment = {');
  expect(source).toContain('getWorker: () => new EditorWorker()');
});

test('does not trigger Monaco rendering from a content widget afterRender callback', () => {
  const afterRender = source.slice(source.indexOf('afterRender:'), source.indexOf('target.addContentWidget(widget)'));
  expect(afterRender).not.toContain('getScrolledVisiblePosition');
  expect(afterRender).not.toContain('getOffsetForColumn');
  expect(afterRender).not.toContain('node.offsetLeft');
  expect(afterRender).toContain('node.style.transform = `translateX(${targetLeft}px)`');
});
