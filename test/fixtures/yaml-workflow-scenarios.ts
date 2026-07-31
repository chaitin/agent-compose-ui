export const minimalYaml = `name: minimal-app
agents: {}
`;

export const complexYaml = `name: 深度测试-app
agents:
  reviewer:
    provider: codex
    model: gpt-test
    system_prompt: 严格审查输入并输出结论
    image: reviewer:dev
    env:
      MODE:
        value: test
      EMPTY: ""
    build:
      context: ./reviewer
      dockerfile: Dockerfile.agent
      target: runtime
      args:
        MODE: production
      platforms: [linux/amd64]
      tags: [reviewer:latest]
  scheduled:
    provider: codex
    model: scheduler-test
    scheduler:
      enabled: true
      script: "export default { triggers: [] }"
  plain: {}
`;

export const invalidYamlInputs = [
  { name: 'empty document', yaml: '' },
  { name: 'sequence root', yaml: '- one\n- two\n' },
  { name: 'scalar root', yaml: 'hello\n' },
  { name: 'malformed mapping', yaml: 'name: [\n' },
] as const;
