# YAML 行内 Skill 配置设计

## 目标

在 YAML 编辑器的每个 `agents.<agent>.skills` 配置位置提供清晰的行内操作入口，使用户可以从 YAML 直接打开底部 Skills 面板、上传或管理当前智能体的本地 Skill，并在用户确认后修正错误的本地 Skill 路径。

该功能建立 YAML 引用与项目 Skill 文件之间的双向操作路径，但不改变 Skill 的运行时加载协议，也不自动修改远程 Skill 配置。

## 用户体验

YAML 编辑器识别位于具体 agent 下的 `skills:` 字段，并在该行末尾显示行内按钮：

- 没有 Skill 条目时显示“添加 Skill”。
- 存在本地 Skill 条目且配置正常时显示“管理 Skill”。
- 存在缺失文件或错误本地路径时显示带警告状态的“修正 Skill”。

点击按钮后，底部资源区域自动展开并切换到 Skills 页签，同时将目标智能体设为 YAML 中按钮所属的 agent。Skills 面板继续使用现有的新建和上传流程。上传成功后，面板将标准本地引用写入该 agent：

```yaml
skills:
  - name: aiwaf-host-investigation
    source: file
    path: ./skills/aiwaf-host-investigation
```

已上传 Skill 的目录结构必须是 `skills/<name>/SKILL.md`。

## YAML 识别与行内控件

新增一个独立的 Skill YAML 定位模块。它解析当前 YAML，返回每个有效 `agents.<name>.skills` 字段的 agent 名称、行号和本地 Skill 引用。解析失败时不显示控件，由现有 YAML 错误展示负责反馈。

`YamlEditor` 根据定位结果管理 Monaco 行内控件。控件绑定语义位置而不是永久绑定行号；每次模型内容变化后重新解析和定位，因此插入、删除或格式化 YAML 后不会操作错误的 agent。编辑器销毁或切换模型时释放控件和监听器。

行内按钮只出现在 agent 下的 `skills:` 字段旁。顶层或其他任意位置的同名字段不产生入口，也不被视为有效 Skill 配置。

## 面板联动

现有 `ScriptWorkspace` 增加一个聚焦 Skills 面板的动作，携带目标 agent 名称。动作执行时：

1. 打开底部资源面板。
2. 将活动页签设为 `skills`。
3. 设置当前 Skill 目标 agent。
4. `ResourcePanel` 将目标 agent 传给 `SkillPanel`。

该目标只用于确定新建、上传和同步配置写入哪个 agent，不改变主编辑器当前内容，也不要求用户先在其他界面选择 agent。

## 路径检查与修正

本地 Skill 的标准引用为：

- `source: file`；兼容读取旧的 `provider: file` 表达。
- `path: ./skills/<name>`。
- 项目存储中存在 `skills/<name>/SKILL.md`。

系统检测到本地 Skill 路径与名称不匹配、路径缺失或引用文件不存在时，在行内按钮和 Skills 面板中显示问题。系统不得静默改写 YAML。

用户点击“修正配置”后显示将要发生的变更；用户确认后才调用现有 YAML mutation 更新 `source` 和 `path`。修正只处理 `file` 类型 Skill，保留 agent 的其他字段、其他 Skill 以及 YAML 中不相关配置。GitHub、URL 或其他非本地来源不参与路径标准化。

如果 YAML 引用存在但文件缺失，面板预填 Skill 名称并引导上传。上传成功后再写入或修正 YAML；上传失败时保持原 YAML 不变。如果文件已上传但 YAML 未引用，用户可在 Skills 面板点击“同步配置”，选择目标 agent 后预览并确认写入标准引用。

## 状态与错误处理

- YAML 无法解析：隐藏行内按钮，保留现有 YAML 错误提示。
- 项目存储绑定尚未建立：打开 Skills 页签并显示现有绑定状态，不提前修改 YAML。
- YAML 引用缺少文件：显示“待上传”，提供预填名称的上传操作。
- 已上传文件缺少 YAML 引用：显示“未配置”，提供“同步配置”。
- 路径非标准：显示旧值与标准值，确认后修正。
- YAML 在确认期间发生变化：重新计算差异，要求用户再次确认，防止覆盖并发编辑。
- 上传成功但 YAML 更新失败：沿用现有回滚策略删除本次新建的 Skill 目录，并报告两阶段操作结果。

## 兼容性与范围

- 保留现有 Skills 面板的新建、上传、编辑、删除和刷新行为。
- 保留现有上传成功后自动写入 YAML 的行为。
- 不修改后端 API、项目存储目录结构或运行时 Skill 加载方式。
- 不把 Prompt 中硬编码的 `/workspace/SKILL.md` 当作项目 Skill 引用，也不自动重写脚本文本。
- 不处理顶层 `skills`、拼写错误字段或 YAML 注释中的文字。

## 测试

测试覆盖：

- 只识别具体 agent 下的 `skills:` 行，并返回正确 agent 和动态行号。
- 多 agent、多 Skill、空列表、旧 `provider` 写法、无效 YAML 和非本地 Skill。
- 行内按钮的“添加”“管理”“修正”状态，以及点击后打开并聚焦正确的 Skills 面板。
- 错误路径只在用户确认后规范化为 `./skills/<name>`，同时保留无关 YAML。
- 缺失文件触发上传引导，上传失败不修改 YAML。
- 已上传但未引用的 Skill 可通过“同步配置”写入指定 agent。
- 编辑过程中行号变化、上下文切换和组件销毁不会留下过期控件或写入错误 agent。
- 现有 Skill 上传、删除引用和资源页签测试继续通过。

实现完成后运行相关 Vitest 组件测试、YAML mutation 单元测试以及仓库适用的类型检查和构建检查。
