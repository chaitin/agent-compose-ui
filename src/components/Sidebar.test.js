import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('./Sidebar.svelte', import.meta.url),
  'utf8',
);

test('provides an accessible persistent icon-rail toggle', () => {
  assert.match(source, /class:collapsed=\{sidebarCollapsed\}/);
  assert.match(source, /aria-label="折叠左侧菜单"/);
  assert.match(source, /aria-label="展开左侧菜单"/);
  assert.match(source, /localStorage\.setItem\(SIDEBAR_COLLAPSED_KEY/);
  assert.match(source, /\.sidebar\.collapsed\s*\{[^}]*width:\s*44px[^}]*min-width:\s*44px/s);
  assert.match(source, /class="expand-handle" aria-hidden="true">›<\/span>/);
  assert.match(source, /\.expand-handle\s*\{[^}]*position:\s*absolute[^}]*right:\s*-10px/s);
});

test('uses the AC lettermark and orchestration icon', () => {
  assert.match(source, /<span class="ac-mark" aria-hidden="true">AC<\/span>/);
  assert.doesNotMatch(source, /class="ac-[ac]"/);
  assert.match(source, /class="smart-agent-icon"/);
  assert.match(source, /aria-hidden="true"[^>]*viewBox="0 0 24 24"/);
  assert.match(source, /\.smart-agent-icon\s*\{[^}]*stroke:\s*currentColor/);
});

test('keeps only global icon actions in the collapsed rail', () => {
  assert.match(source, /\{#if sidebarCollapsed\}[\s\S]*class="rail-app-button"[\s\S]*\{:else\}[\s\S]*class="nav-section project-section"/);
  assert.match(source, /\{#if !sidebarCollapsed\}<span class="nav-label">系统管理<\/span>\{\/if\}/);
  assert.match(source, /\{#if !sidebarCollapsed\}<span class="nav-label">反馈<\/span>\{\/if\}/);
});

test('deletes a project from a separate button without selecting it', () => {
  assert.match(source, /class="project-delete"/);
  assert.match(source, /<svg[^>]*class="delete-icon"[\s\S]*<path/);
  assert.doesNotMatch(source, /\? '…' : '×'/);
  assert.match(source, /event\.stopPropagation\(\)/);
  assert.match(source, /await cascadeDeleteProject\(projectId, cascadeDeleteClient\)/);
  assert.match(source, /项目定义、关联 Sandbox 与脚本目录/);
  assert.match(source, /运行历史将保留/);
  assert.match(source, /Sandbox 清理失败时项目不会被删除/);
  assert.match(source, /removedSandboxes[\s\S]*Sandbox[\s\S]*运行历史已保留/);
});

test('confirms deletion with both project name and source path', () => {
  assert.match(source, /project\.summary\.name/);
  assert.match(source, /project\.summary\.sourcePath/);
  assert.match(source, /window\.confirm/);
});

test('clears selection and opens the empty new-project editor after deleting the active project', () => {
  assert.match(source, /store\.removeProjectEditor\(projectId\)/);
  assert.match(source, /store\.activeProjectId = ''/);
  assert.match(source, /store\.editorContent = EMPTY_YAML_TEMPLATE/);
  assert.match(source, /store\.goTo\('project'\)/);
});

test('does not render the overview menu', () => {
  assert.doesNotMatch(source, />\s*总览\s*</);
});

test('renders a filter input for the agent app list', () => {
  assert.match(source, /class="project-filter"/);
  assert.match(source, /placeholder="筛选应用…"/);
  assert.match(source, /oninput=\{onFilterInput\}/);
});

test('sends the project filter to backend query', () => {
  assert.match(source, /query: filterText\.trim\(\)/);
  assert.match(source, /loadProjects\(true\)/);
});

test('paginates the list through ListProjects offset and limit', () => {
  assert.match(source, /const PAGE_SIZE = 10/);
  assert.match(source, /offset: reset \? 0 : projectOffset/);
  assert.match(source, /limit: PAGE_SIZE/);
  assert.match(source, /resp\.hasMore/);
  assert.match(source, /resp\.nextOffset/);
  assert.match(source, /加载更多/);
});

test('ignores stale filter responses and always clears loading state', () => {
  assert.match(source, /requestGeneration/);
  assert.match(source, /generation !== requestGeneration/);
  assert.match(source, /finally/);
  assert.match(source, /filterLoading = false/);
});

test('shows an empty hint when no project matches the filter', () => {
  assert.match(source, /无匹配的智能体应用/);
});

test('loads and displays pending global-variable synchronization without applying projects', () => {
  assert.match(source, /getProjectEnvStatus/);
  assert.match(source, /变量已更新，待同步/);
  assert.doesNotMatch(source, /getProjectEnvStatus[\s\S]{0,300}applyProject/);
});

test('opens unified system management at daemon images', () => {
  assert.match(source, />\s*系统管理\s*</);
  assert.doesNotMatch(source, /section-header">资源管理/);
  assert.match(source, /store\.goTo\('images'\)/);
});

test('shows an external feedback entry below system management', () => {
  assert.match(source, /系统管理[\s\S]*反馈/);
  assert.match(source, /href="https:\/\/devboard\.chaitin\.net\/devboard\/issues\?product_id=6a5f3c14839f64bb543f172d"/);
  assert.match(source, /target="_blank"/);
  assert.match(source, /rel="noopener noreferrer"/);
});

test('uses the approved compact high-density dimensions', () => {
  assert.match(source, /\.brand\s*\{[\s\S]*?min-height:\s*46px/);
  assert.match(source, /\.section-header\s*\{[^}]*font-size:\s*var\(--font-size-md\)/);
  assert.match(source, /\.project-filter\s*\{[\s\S]*?height:\s*30px/);
  assert.match(source, /\.filter-box\s*\{[\s\S]*?padding:\s*0 0 6px/);
  assert.match(source, /\.project-row\s*\{[\s\S]*?min-height:\s*30px/);
  assert.match(source, /\.project-name\s*\{[\s\S]*?font-family:\s*var\(--font-mono\)/);
  assert.match(source, /border:\s*1px solid color-mix\(in srgb, var\(--accent-blue\) 10%, var\(--border-color\)\)/);
  assert.match(source, /\.new-project-btn\s*\{[\s\S]*?text-align:\s*center/);
});

test('exposes list structure without decorative ordinal indices', () => {
  assert.match(source, /id="project-list-heading"/);
  assert.match(source, /aria-labelledby="project-list-heading"/);
  assert.doesNotMatch(source, /class="project-index"/);
});

test('keeps active, delete, and keyboard focus states visible', () => {
  assert.match(source, /\.project-row\.active::before/);
  assert.match(source, /\.project-row:focus-within \.project-delete/);
  assert.match(source, /:focus-visible/);
});

test('renders equally sized load-more and create buttons', () => {
  assert.match(source, /class="project-actions"[\s\S]*class="load-more-btn"[\s\S]*class="new-project-btn"/);
  assert.match(source, /\.load-more-btn,[\s\S]*?\.new-project-btn\s*\{[\s\S]*?width:\s*100%[\s\S]*?min-height:\s*30px/);
  assert.match(source, /\.load-more-btn\s*\{[\s\S]*?border:\s*1px solid var\(--border-color\)/);
  assert.match(source, /\.new-project-btn:hover[\s\S]*?border-color:\s*color-mix\(in srgb, var\(--accent-blue\) 30%, var\(--border-color\)\)/);
  assert.match(source, /\.project-actions\s*\{[\s\S]*?border-top:\s*1px solid var\(--border-color\)/);
});
