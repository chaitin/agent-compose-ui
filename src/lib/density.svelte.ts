// 密度切换：改根字号即整体缩放（舒适 / 紧凑），持久化到 localStorage。
const KEY = 'ac.density';
type Density = 'comfortable' | 'compact';
const SIZE: Record<Density, string> = { comfortable: '15px', compact: '13.5px' };

class DensityState {
  value = $state<Density>('comfortable');

  init(): void {
    const stored = localStorage.getItem(KEY) as Density | null;
    if (stored === 'comfortable' || stored === 'compact') this.value = stored;
    this.apply();
  }

  private apply(): void {
    document.documentElement.style.fontSize = SIZE[this.value];
  }

  toggle = (): void => {
    this.value = this.value === 'comfortable' ? 'compact' : 'comfortable';
    localStorage.setItem(KEY, this.value);
    this.apply();
  };
}

export const density = new DensityState();
