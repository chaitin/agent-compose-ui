// 命令面板开关的共享状态：顶栏按钮与全局 ⌘K 快捷键都控制它。
class CommandState {
  open = $state(false);
  toggle = () => {
    this.open = !this.open;
  };
}

export const command = new CommandState();
