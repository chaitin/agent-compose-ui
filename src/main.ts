import { mount } from 'svelte';

import AppShell from './AppShell.svelte';
import './app.css';

const app = mount(AppShell, {
  target: document.getElementById('app')!,
});

export default app;
