export type AgentDefinition = {
  id: string;
  name: string;
  source: 'system' | 'uploaded';
  description: string;
  defaultAgent: string;
  workspacePolicy: string;
  requiredCapabilities: string[];
  status: string;
};

export const builtinAgents: AgentDefinition[] = [
  {
    id: 'general-codex',
    name: '通用研发助手',
    source: 'system',
    description: '基于当前 workspace 进行代码阅读、修改建议和任务执行。',
    defaultAgent: 'codex',
    workspacePolicy: '可选 workspace',
    requiredCapabilities: [],
    status: '可用',
  },
  {
    id: 'doc-review',
    name: '文档分析助手',
    source: 'system',
    description: '面向文档摘要、审阅和结构化输出的内置智能体。',
    defaultAgent: 'codex',
    workspacePolicy: '无需 workspace',
    requiredCapabilities: [],
    status: '可用',
  },
];
